// Validação estática: sintaxe, imports relativos e exports nomeados de todos os módulos.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const files = [];
function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) files.push(full);
  }
}
['src', 'scripts', 'tests'].forEach((d) => walk(path.resolve(d)));

let failed = false;
const fail = (msg) => { failed = true; console.error(msg); };

// 1) Sintaxe de todos os arquivos
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) fail(`Sintaxe inválida em ${file}\n${result.stderr}`);
}

// 2) Todo import relativo aponta para um arquivo existente
const importRe = /(?:import|export)\s[^'"]*?from\s+['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
for (const file of files) {
  for (const m of fs.readFileSync(file, 'utf8').matchAll(importRe)) {
    if (!fs.existsSync(path.resolve(path.dirname(file), m[1] || m[2]))) fail(`Import quebrado em ${file}: ${m[1] || m[2]}`);
  }
}

// 3) Ligação ESM (exports nomeados existem): carrega cada módulo de src/ exceto o ponto de entrada,
//    que inicia o bot. deploy-commands.js só age quando executado diretamente.
if (!failed) {
  const srcDir = `${path.resolve('src')}${path.sep}`;
  for (const file of files.filter((f) => f.startsWith(srcDir) && path.basename(f) !== 'index.js')) {
    try { await import(pathToFileURL(file).href); } catch (error) { fail(`Falha ao carregar ${file}: ${error.message}`); }
  }
}

if (failed) process.exit(1);
console.log(`OK: sintaxe, imports e exports válidos em ${files.length} arquivos JavaScript.`);
process.exit(0);
