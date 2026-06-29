import { getLlama } from "node-llama-cpp";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

const llama = await getLlama("lastBuild");

const rwkv = llama.loadModel({
  modelPath: "models/rwkv7-g1g-2.9b-20260526-ctx8192-Q4_K_M.gguf",
});

yargs(hideBin(process.argv));
