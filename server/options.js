import { parseArgs } from 'node:util';

export function startupOptions(args = process.argv.slice(2), env = process.env) {
  const { values } = parseArgs({
    args,
    options: {
      port: { type: 'string', short: 'p' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) return { help: true };
  const input = values.port ?? env.PORT ?? '3000';
  if (!/^\d+$/.test(input) || !Number.isInteger(Number(input)) || Number(input) > 65535) {
    throw new Error('Port must be an integer from 0 to 65535');
  }
  return { port: Number(input), host: env.HOST ?? '0.0.0.0' };
}

export const USAGE = `Usage: npm start -- [--port <port>]

  -p, --port <port>  Listening port (overrides PORT; default: 3000)
  -h, --help         Show this help

Examples:
  npm start -- --port 8080
  npm start -- -p 8080
  node server/index.js --port=8080
`;
