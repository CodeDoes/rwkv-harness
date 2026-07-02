use napi::bindgen_prelude::*;
use napi_derive::napi;
use safetensors;

use web_rwkv::{
    context::{ContextBuilder, InstanceExt},
    runtime::{
        infer::{Rnn, RnnInput, RnnInputBatch, RnnOption},
        loader::Loader,
        model::{ContextAutoLimits, ModelBuilder, ModelVersion, Quant},
        v7, TokioRuntime,
    },
    tokenizer::Tokenizer,
    wgpu,
};
use half::f16;

fn argmax(slice: &[f32]) -> u32 {
    slice.iter()
        .enumerate()
        .max_by(|(_, a), (_, b)| a.total_cmp(b))
        .map(|(i, _)| i as u32)
        .unwrap_or(0)
}

#[napi]
pub struct RWSession {
    runtime: Option<TokioRuntime<Rnn>>,
    tokenizer: Option<Tokenizer>,
}

#[napi]
impl RWSession {
    #[napi(constructor)]
    pub fn new() -> Result<Self> {
        Ok(Self {
            runtime: None,
            tokenizer: None,
        })
    }

    #[napi]
    pub async unsafe fn init(
        &mut self,
        model_path: String,
        vocab_path: Option<String>,
        quant_layers: Option<u32>,
    ) -> Result<()> {
        let model_path = std::path::Path::new(&model_path);
        let vocab_path = vocab_path.unwrap_or_else(|| {
            let mut p = model_path.parent().unwrap().to_path_buf();
            p.push("rwkv_vocab_v20230424.json");
            p.to_string_lossy().to_string()
        });

        let vocab_content = std::fs::read_to_string(&vocab_path)
            .map_err(|e| Error::new(Status::GenericFailure, format!("Failed to read vocab: {}", e)))?;
        let tokenizer = Tokenizer::new(&vocab_content)
            .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;

        let file = std::fs::File::open(model_path)
            .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
        let data = unsafe { memmap2::Mmap::map(&file) }
            .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
        let model = safetensors::SafeTensors::deserialize(&data)
            .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
        let info = Loader::info(&model)
            .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;

        let instance = wgpu::Instance::default();
        let adapter = instance
            .adapter(wgpu::PowerPreference::HighPerformance)
            .await
            .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
        let context = ContextBuilder::new(adapter)
            .auto_limits(&info)
            .build()
            .await
            .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;

        let quant = (0..quant_layers.unwrap_or(0) as usize)
            .map(|layer| (layer, Quant::Int8))
            .collect();
        let builder = ModelBuilder::new(&context, model).quant(quant);

        let runtime = match info.version {
            ModelVersion::V7 => {
                let model = builder
                    .build_v7()
                    .await
                    .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
                let bundle = v7::Bundle::<f16>::new(model, 1);
                TokioRuntime::<Rnn>::new(bundle).await
            }
            _ => return Err(Error::new(Status::GenericFailure, "Only RWKV v7 supported")),
        };

        self.runtime = Some(runtime);
        self.tokenizer = Some(tokenizer);
        Ok(())
    }

    #[napi]
    pub fn tokenize(&self, text: String) -> Result<Vec<u32>> {
        let tokenizer = self
            .tokenizer
            .as_ref()
            .ok_or_else(|| Error::new(Status::GenericFailure, "Tokenizer not initialized"))?;
        tokenizer
            .encode(text.as_bytes())
            .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))
    }

    #[napi]
    pub fn detokenize(&self, tokens: Vec<u32>) -> Result<String> {
        let tokenizer = self
            .tokenizer
            .as_ref()
            .ok_or_else(|| Error::new(Status::GenericFailure, "Tokenizer not initialized"))?;
        let bytes = tokenizer
            .decode(&tokens)
            .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
        String::from_utf8(bytes)
            .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))
    }

    #[napi]
    pub async fn infer(
        &self,
        tokens: Vec<u32>,
        max_tokens: Option<u32>,
    ) -> Result<String> {
        let runtime = self
            .runtime
            .as_ref()
            .ok_or_else(|| Error::new(Status::GenericFailure, "Runtime not initialized"))?;
        let tokenizer = self
            .tokenizer
            .as_ref()
            .ok_or_else(|| Error::new(Status::GenericFailure, "Tokenizer not initialized"))?;

        let max_tokens = max_tokens.unwrap_or(256) as usize;
        let mut output = String::new();

        let prompt = RnnInputBatch::new(tokens, RnnOption::Last);
        let mut prompt = RnnInput::new(vec![prompt], 128);

        for _ in 0..max_tokens {
            let input = prompt.clone();
            let (input, result) = runtime
                .infer(input)
                .await
                .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
            prompt = input;

            let logits = result[0].0.clone();
            if logits.size() > 0 {
                let probs = logits.to_vec();
                let token = argmax(&probs);

                if token == 0 {
                    break;
                }

                let decoded = tokenizer
                    .decode(&[token])
                    .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
                let word = String::from_utf8_lossy(&decoded).to_string();
                output.push_str(&word);

                prompt.batches[0].push(token);
            }
        }

        Ok(output)
    }
}
