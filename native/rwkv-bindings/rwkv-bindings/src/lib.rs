use napi::bindgen_prelude::*;
use napi_derive::napi;
use web_rwkv::{
    context::{Context, ContextBuilder},
    tokenizer::Tokenizer,
    runtime::{
        loader::Loader,
        infer::{Rnn, RnnInput, RnnInputBatch, RnnOption},
        v7, Runtime, TokioRuntime,
    },
    tokenizer::Tokenizer,
};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

#[napi]
pub struct RWSession {
    runtime: Option<Box<dyn Runtime<Rnn>>>,
    tokenizer: Arc<Tokenizer>,
}

#[napi]
impl RWSession {
    #[napi(constructor)]
    pub fn new(model_path: String, vocab_path: Option<String>) -> Result<Self> {
        let model_path = std::path::Path::new(&model_path);
        let vocab_path = vocab_path.unwrap_or_else(|| {
            let mut p = model_path.parent().unwrap().to_path_buf();
            p.push("rwkv_vocab_v20230424.json");
            p.to_string_lossy().to_string()
        });

        // Load tokenizer
        let tokenizer = Arc::new(Tokenizer::new(vocab_path)
            .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?);

        // We'll initialize runtime on first use (lazy init)
        Ok(Self {
            runtime: None,
            tokenizer,
        })
    }

    #[napi]
    pub fn init_runtime(&mut self, model_path: String) -> Result<()> {
        let model_path = std::path::Path::new(&model_path);
        
        // Load model file
        let data = std::fs::read(model_path)
            .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
        
        let model = safetensors::SafeTensors::deserialize(&data)
            .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
        
        let info = Loader::info(&model)
            .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;

        // Create context (GPU)
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

        // Build model + runtime
        let builder = web_rwkv::runtime::loader::ModelBuilder::new(&context, model);
        
        let runtime: Box<dyn Runtime<web_rwkv::runtime::infer::Rnn>> = match info.version {
            web_rwkv::runtime::model::ModelVersion::V7 => {
                let model = web_rwkv::runtime::v7::ModelBuilder::new(&context, info.clone())
                    .build_v7()
                    .await
                    .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
                let bundle = web_rwkv::runtime::v7::Bundle::<half::f16>::new(model, 1);
                Box::new(TokioRuntime::<web_rwkv::runtime::infer::Rnn>::new(bundle).await)
            }
            _ => return Err(Error::new(Status::GenericFailure, "Only RWKV v7 supported")),
        };

        self.runtime = Some(runtime);
        Ok(())
    }

    #[napi]
    pub fn tokenize(&self, text: String) -> Result<Vec<u32>> {
        let tokens = self.tokenizer.encode(text.as_bytes())
            .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
        Ok(tokens)
    }

    #[napi]
    pub fn detokenize(&self, tokens: Vec<u32>) -> Result<String> {
        let bytes = self.tokenizer.decode(&tokens)
            .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
        String::from_utf8(bytes)
            .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))
    }

    #[napi]
    pub async fn infer(&self, tokens: Vec<u32>, max_tokens: Option<u32>) -> Result<String> {
        let runtime = self.runtime.as_ref()
            .ok_or_else(|| Error::new(Status::GenericFailure, "Runtime not initialized"))?;

        let max_tokens = max_tokens.unwrap_or(256) as usize;
        let mut output = String::new();
        let mut current_tokens = tokens;

        let mut prompt = web_rwkv::runtime::infer::RnnInputBatch::new(
            current_tokens, 
            web_rwkv::runtime::infer::RnnOption::Last
        );
        let mut prompt = web_rwkv::runtime::infer::RnnInput::new(vec![prompt], 128);

        for _ in 0..max_tokens {
            let input = prompt.clone();
            let (new_prompt, output) = runtime.infer(input).await
                .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
            prompt = new_prompt;

            let output = output[0].0.clone();
            if output.size() > 0 {
                let probs = web_rwkv::runtime::softmax::softmax_one(&self.context, output).await
                    .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
                let probs = probs.to_vec();
                let token = probs.iter()
                    .enumerate()
                    .max_by(|(_, x), (_, y)| x.total_cmp(y))
                    .unwrap()
                    .0 as u32;

                if token == 0 { break; }

                let decoded = self.detokenize(vec![token])?;
                output.push_str(&decoded);
                
                prompt.batches[0].push(token);
            } else {
                // prefill
            }
        }

        Ok(output)
    }

    #[napi]
    pub fn tokenize(&self, text: String) -> Result<Vec<u32>> {
        let tokens = self.tokenizer.encode(text.as_bytes())
            .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
        Ok(tokens)
    }

    #[napi]
    pub fn detokenize(&self, tokens: Vec<u32>) -> Result<String> {
        let bytes = self.tokenizer.decode(&tokens)
            .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
        String::from_utf8(bytes)
            .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))
    }
}

#[napi]
pub fn create_session(model_path: String, vocab_path: Option<String>) -> Result<RWSession> {
    RWSession::new(model_path, vocab_path)
}
