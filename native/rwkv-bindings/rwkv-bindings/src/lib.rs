use napi::bindgen_prelude::*;
use napi::threadsafe_function::*;
use napi_derive::napi;
use half::f16;

use schoolmarm::{Grammar, GrammarState};

use web_rwkv::{
    context::{ContextBuilder, InstanceExt},
    runtime::{
        infer::{Rnn, RnnInput, RnnInputBatch, RnnOption},
        loader::Loader,
        model::{ContextAutoLimits, ModelBuilder, ModelVersion, Quant, Bundle, State},
        v7, TokioRuntime,
    },
    tokenizer::Tokenizer,
    tensor::{TensorCpu, TensorInit},
    wgpu,
};

fn argmax(slice: &[f32]) -> u32 {
    slice.iter()
        .enumerate()
        .max_by(|(_, a), (_, b)| a.total_cmp(b))
        .map(|(i, _)| i as u32)
        .unwrap_or(0)
}

fn sample(logits: &[f32], temperature: f32, top_p: f32) -> u32 {
    if temperature <= 0.0 {
        return argmax(logits);
    }

    let max_val = logits.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
    let exp_sum: f32 = logits.iter().map(|l| (l - max_val).exp()).sum();
    if exp_sum <= 0.0 {
        return argmax(logits);
    }
    let probs: Vec<f32> = logits.iter().map(|l| (l - max_val).exp() / exp_sum).collect();

    let mut indices: Vec<usize> = (0..probs.len()).collect();
    indices.sort_by(|&a, &b| probs[b].partial_cmp(&probs[a]).unwrap_or(std::cmp::Ordering::Equal));

    let mut cumsum = 0.0;
    let cutoff = indices.iter()
        .position(|&i| { cumsum += probs[i]; cumsum >= top_p })
        .map(|pos| pos + 1)
        .unwrap_or(indices.len())
        .max(1);

    let candidates = &indices[..cutoff];
    let weights: Vec<f32> = candidates.iter().map(|&i| probs[i].powf(1.0 / temperature)).collect();

    use rand::distributions::WeightedIndex;
    use rand::prelude::*;
    let total: f32 = weights.iter().sum();
    if total <= 0.0 {
        return candidates[0] as u32;
    }
    let dist = WeightedIndex::new(&weights).unwrap();
    let mut rng = rand::thread_rng();
    candidates[dist.sample(&mut rng)] as u32
}

#[napi]
pub struct RWSession {
    runtime: Option<TokioRuntime<Rnn>>,
    state: Option<Box<dyn State + Send + Sync + 'static>>,
    tokenizer: Option<Tokenizer>,
    token_strings: Vec<String>,
    grammar: Option<Grammar>,
}

#[napi]
impl RWSession {
    #[napi(constructor)]
    pub fn new() -> Result<Self> {
        Ok(Self {
            runtime: None,
            state: None,
            tokenizer: None,
            token_strings: Vec::new(),
            grammar: None,
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

        let token_bytes = tokenizer.token_index_to_bytes();
        let token_strings: Vec<String> = token_bytes.iter()
            .map(|b| {
                // Lossless encoding: ASCII 0x00-0x7F pass through,
                // non-ASCII 0x80-0xFF map to PUA U+E000-U+E07F
                let mut s = String::with_capacity(b.len());
                for &byte in b {
                    if byte < 0x80 {
                        s.push(byte as char);
                    } else {
                        s.push(char::from_u32(0xE000 + (byte as u32 - 0x80)).unwrap());
                    }
                }
                s
            })
            .collect();
        self.token_strings = token_strings;

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

        match info.version {
            ModelVersion::V7 => {
                let model = builder
                    .build_v7()
                    .await
                    .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
                let bundle = v7::Bundle::<f16>::new(model, 1);
                let state_copy = bundle.state();

                self.state = Some(Box::new(state_copy));
                let os_runtime = TokioRuntime::<Rnn>::new(bundle).await;
                self.runtime = Some(os_runtime);
                self.tokenizer = Some(tokenizer);
            }
            _ => return Err(Error::new(Status::GenericFailure, "Only RWKV v7 supported")),
        }

        Ok(())
    }

    #[napi]
    pub fn set_grammar(&mut self, grammar_str: String) -> Result<()> {
        let grammar = Grammar::new(&grammar_str)
            .map_err(|e| Error::new(Status::GenericFailure, format!("Grammar error: {}", e)))?;
        self.grammar = Some(grammar);
        Ok(())
    }

    #[napi]
    pub fn clear_grammar(&mut self) {
        self.grammar = None;
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
        temperature: Option<f64>,
        top_p: Option<f64>,
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
        let temperature = temperature.unwrap_or(0.8) as f32;
        let top_p = top_p.unwrap_or(0.9) as f32;

        let mut grammar_state = self.grammar.as_ref()
            .map(|g| GrammarState::new(g.clone()))
            .transpose()
            .map_err(|e| Error::new(Status::GenericFailure, format!("Grammar state error: {}", e)))?;

        let vocab_refs: Vec<&str> = self.token_strings.iter()
            .map(|s| s.as_str())
            .collect();

        let mut output = String::new();
        let batch = RnnInputBatch::new(tokens, RnnOption::Last);
        let mut prompt = RnnInput::new(vec![batch], 128);

        // Flush all prompt tokens before starting generation
        loop {
            let info_opt = (&prompt).into_iter().next();
            if info_opt.is_none() {
                break;
            }
            let (input_result, result) = runtime
                .infer(prompt)
                .await
                .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
            prompt = input_result;
            if prompt.num_token() == 0 {
                // All prompt tokens consumed — keep the logits for generation
                let logits = result[0].0.clone();
                if logits.size() == 0 {
                    break;
                }
                let mut probs = logits.to_vec();
                if let Some(ref gs) = grammar_state {
                    let allowed = gs.allowed_tokens(&vocab_refs);
                    if !allowed.iter().any(|&x| x) {
                        break;
                    }
                    for (i, &ok) in allowed.iter().enumerate() {
                        if !ok {
                            probs[i] = f32::NEG_INFINITY;
                        }
                    }
                }
                let token = sample(&probs, temperature, top_p);
                if token == 0 {
                    break;
                }
                if let Some(ref mut gs) = grammar_state {
                    if let Some(word) = self.token_strings.get(token as usize) {
                        let _ = gs.accept_token(word);
                    }
                }
                let decoded = tokenizer
                    .decode(&[token])
                    .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
                let word = String::from_utf8_lossy(&decoded).to_string();
                output.push_str(&word);
                prompt.batches[0].push(token);
                break; // done flushing, enter generation loop below
            }
            // prompt still has unprocessed tokens, continue flushing
        }

        for _ in 0..max_tokens.saturating_sub(1) {
            let input = prompt.clone();
            let (input_result, result) = runtime
                .infer(input)
                .await
                .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
            prompt = input_result;

            let logits = result[0].0.clone();
            let token = if logits.size() > 0 {
                let mut probs = logits.to_vec();
                if let Some(ref gs) = grammar_state {
                    let allowed = gs.allowed_tokens(&vocab_refs);
                    if !allowed.iter().any(|&x| x) {
                        break;
                    }
                    for (i, &ok) in allowed.iter().enumerate() {
                        if !ok {
                            probs[i] = f32::NEG_INFINITY;
                        }
                    }
                }
                sample(&probs, temperature, top_p)
            } else {
                break;
            };

            if token == 0 {
                break;
            }

            if let Some(ref mut gs) = grammar_state {
                if let Some(word) = self.token_strings.get(token as usize) {
                    let _ = gs.accept_token(word);
                }
            }

            let decoded = tokenizer
                .decode(&[token])
                .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
            let word = String::from_utf8_lossy(&decoded).to_string();
            output.push_str(&word);

            prompt.batches[0].push(token);
        }

        Ok(output)
    }

    #[napi]
    pub async fn infer_stream(
        &self,
        tokens: Vec<u32>,
        #[napi(ts_arg_type = "(token: string) => void")] on_token: ThreadsafeFunction<String, ErrorStrategy::Fatal>,
        max_tokens: Option<u32>,
        temperature: Option<f64>,
        top_p: Option<f64>,
    ) -> Result<String> {
        let tsfn = on_token;

        let runtime = self
            .runtime
            .as_ref()
            .ok_or_else(|| Error::new(Status::GenericFailure, "Runtime not initialized"))?;
        let tokenizer = self
            .tokenizer
            .as_ref()
            .ok_or_else(|| Error::new(Status::GenericFailure, "Tokenizer not initialized"))?;

        let max_tokens = max_tokens.unwrap_or(256) as usize;
        let temperature = temperature.unwrap_or(0.8) as f32;
        let top_p = top_p.unwrap_or(0.9) as f32;

        let mut grammar_state = self.grammar.as_ref()
            .map(|g| GrammarState::new(g.clone()))
            .transpose()
            .map_err(|e| Error::new(Status::GenericFailure, format!("Grammar state error: {}", e)))?;

        let vocab_refs: Vec<&str> = self.token_strings.iter()
            .map(|s| s.as_str())
            .collect();

        let mut output = String::new();
        let batch = RnnInputBatch::new(tokens, RnnOption::Last);
        let mut prompt = RnnInput::new(vec![batch], 128);

        // Flush all prompt tokens before starting generation
        loop {
            let info_opt = (&prompt).into_iter().next();
            if info_opt.is_none() {
                break;
            }
            let (input_result, result) = runtime
                .infer(prompt)
                .await
                .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
            prompt = input_result;
            if prompt.num_token() == 0 {
                let logits = result[0].0.clone();
                if logits.size() == 0 {
                    break;
                }
                let mut probs = logits.to_vec();
                if let Some(ref gs) = grammar_state {
                    let allowed = gs.allowed_tokens(&vocab_refs);
                    if !allowed.iter().any(|&x| x) {
                        break;
                    }
                    for (i, &ok) in allowed.iter().enumerate() {
                        if !ok {
                            probs[i] = f32::NEG_INFINITY;
                        }
                    }
                }
                let token = sample(&probs, temperature, top_p);
                if token == 0 {
                    break;
                }
                if let Some(ref mut gs) = grammar_state {
                    if let Some(word) = self.token_strings.get(token as usize) {
                        let _ = gs.accept_token(word);
                    }
                }
                let decoded = tokenizer
                    .decode(&[token])
                    .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
                let word = String::from_utf8_lossy(&decoded).to_string();
                output.push_str(&word);
                tsfn.call(
                    word,
                    ThreadsafeFunctionCallMode::NonBlocking,
                );
                prompt.batches[0].push(token);
                break;
            }
        }

        for _ in 0..max_tokens.saturating_sub(1) {
            let input = prompt.clone();
            let (input_result, result) = runtime
                .infer(input)
                .await
                .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
            prompt = input_result;

            let logits = result[0].0.clone();
            let token = if logits.size() > 0 {
                let mut probs = logits.to_vec();
                if let Some(ref gs) = grammar_state {
                    let allowed = gs.allowed_tokens(&vocab_refs);
                    if !allowed.iter().any(|&x| x) {
                        break;
                    }
                    for (i, &ok) in allowed.iter().enumerate() {
                        if !ok {
                            probs[i] = f32::NEG_INFINITY;
                        }
                    }
                }
                sample(&probs, temperature, top_p)
            } else {
                break;
            };

            if token == 0 {
                break;
            }

            if let Some(ref mut gs) = grammar_state {
                if let Some(word) = self.token_strings.get(token as usize) {
                    let _ = gs.accept_token(word);
                }
            }

            let decoded = tokenizer
                .decode(&[token])
                .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
            let word = String::from_utf8_lossy(&decoded).to_string();
            output.push_str(&word);
            tsfn.call(
                word,
                ThreadsafeFunctionCallMode::NonBlocking,
            );

            prompt.batches[0].push(token);
        }

        Ok(output)
    }

    #[napi]
    pub fn get_state_size(&self) -> Result<i64> {
        let state = self
            .state
            .as_ref()
            .ok_or_else(|| Error::new(Status::GenericFailure, "State not initialized"))?;
        let shape = state.init_shape();
        let bytes = shape.iter().product::<usize>() * 4;
        Ok(bytes as i64)
    }

    #[napi]
    pub async fn save_state(&self, path: String) -> Result<()> {
        let state = self
            .state
            .as_ref()
            .ok_or_else(|| Error::new(Status::GenericFailure, "State not initialized"))?;
        let cpu_tensor = state.back(0).await
            .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
        let data = cpu_tensor.data();
        let bytes: Vec<u8> = data.iter().flat_map(|f| f.to_ne_bytes()).collect();
        std::fs::write(&path, &bytes)
            .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
        Ok(())
    }

    #[napi]
    pub async fn load_state(&self, path: String) -> Result<()> {
        let state = self
            .state
            .as_ref()
            .ok_or_else(|| Error::new(Status::GenericFailure, "State not initialized"))?;
        let bytes = std::fs::read(&path)
            .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
        let shape = state.init_shape();
        let total: usize = shape.iter().product();
        let data: Vec<f32> = bytes
            .chunks_exact(4)
            .map(|c| f32::from_ne_bytes([c[0], c[1], c[2], c[3]]))
            .collect();
        if data.len() != total {
            return Err(Error::new(
                Status::GenericFailure,
                format!("State data mismatch: expected {} floats, got {}", total, data.len()),
            ));
        }
        let tensor = TensorCpu::<f32>::from_data(shape, data)
            .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
        state.load(tensor, 0)
            .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
        Ok(())
    }

    #[napi]
    pub async fn evaluate(&self, text: String) -> Result<()> {
        let runtime = self
            .runtime
            .as_ref()
            .ok_or_else(|| Error::new(Status::GenericFailure, "Runtime not initialized"))?;
        let tokenizer = self
            .tokenizer
            .as_ref()
            .ok_or_else(|| Error::new(Status::GenericFailure, "Tokenizer not initialized"))?;

        let tokens = tokenizer
            .encode(text.as_bytes())
            .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
        if tokens.is_empty() {
            return Ok(());
        }

        let batch = RnnInputBatch::new(tokens, RnnOption::Last);
        let input = RnnInput::new(vec![batch], 128);

        let mut current = input;
        loop {
            let info_opt = (&current).into_iter().next();
            if info_opt.is_none() {
                break;
            }
            let (next, _) = runtime
                .infer(current)
                .await
                .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
            if next.num_token() == 0 {
                break;
            }
            current = next;
        }

        Ok(())
    }
}
