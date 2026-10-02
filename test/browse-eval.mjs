// browse: evaluate one expression in a Flow window over CDP and print the JSON result.
// usage: node test/browse-eval.mjs <port> '<expression>' [url-substring]
import { connectTo, evaluate } from './ui-lib.mjs';
const [port, expr, match] = process.argv.slice(2);
const page = await connectTo(Number(port), match || 'index.html');
try {
  const v = await evaluate(page, expr);
  process.stdout.write(`${typeof v === 'string' ? v : JSON.stringify(v, null, 1)}\n`);
} finally {
  page.ws.close();
}




