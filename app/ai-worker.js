// Web worker that runs the local AI engine (WebLLM) off the main thread.
import { WebWorkerMLCEngineHandler } from '../assets/vendor/web-llm.js';

const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (msg) => handler.onmessage(msg);
