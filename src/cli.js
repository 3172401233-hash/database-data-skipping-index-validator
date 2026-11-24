#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { evaluateDataSkipping } from './engine.js';

function printUsage() {
  console.error('用法: node src/cli.js <场景文件.json> [--pretty]');
  console.error('示例: node src/cli.js scenarios/example.json --pretty');
}

async function main() {
  const args = process.argv.slice(2);
  const filePath = args.find((arg) => !arg.startsWith('--'));
  const pretty = args.includes('--pretty');

  if (!filePath) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  try {
    const raw = await readFile(resolve(process.cwd(), filePath), 'utf8');
    const input = JSON.parse(raw);
    const report = evaluateDataSkipping(input);
    console.log(JSON.stringify(report, null, pretty ? 2 : 0));
  } catch (error) {
    console.error(`验证失败: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
