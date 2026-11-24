import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { validateImage, downloadAttachment, uploadPhoto, removePhoto, downloadPhoto } from '../src/services/images.js';
import { UserError } from '../src/utils/errors.js';
import { createFakeDb } from './helpers/fakeDb.js';

const MB = 1024 * 1024;
const make = (w, h, fmt = 'jpeg', opts = {}) => sharp({ create: { width: w, height: h, channels: 3, background: '#336699' } })[fmt](opts.encode).withMetadata(opts.meta || {}).toBuffer();

test('aceita 9:16 em JPEG, PNG e WEBP', async () => {
  for (const [fmt, mime] of [['jpeg', 'image/jpeg'], ['png', 'image/png'], ['webp', 'image/webp']]) {
    const info = await validateImage(await make(540, 960, fmt), 8 * MB);
    assert.equal(info.mime, mime); assert.equal(info.width, 540); assert.equal(info.height, 960);
  }
});
test('recusa proporções diferentes de 9:16', async () => {
  for (const [w, h] of [[1920, 1080], [1000, 1000], [1080, 1350], [1170, 2532]]) {
    await assert.rejects(validateImage(await make(w, h), 8 * MB), /9:16/, `${w}x${h}`);
  }
});
test('recusa resolução mínima, arquivo corrompido, vazio, grande e formato não permitido', async () => {
  await assert.rejects(validateImage(await make(180, 320), 8 * MB), /Resolução mínima/);
  await assert.rejects(validateImage(Buffer.from('isto não é imagem'), 8 * MB), /inválido ou corrompido/);
  await assert.rejects(validateImage(Buffer.alloc(0), 8 * MB), /vazia/);
  await assert.rejects(validateImage(await make(540, 960), 100), /limite/);
  const gif = await sharp({ create: { width: 540, height: 960, channels: 3, background: '#fff' } }).gif().toBuffer();
  await assert.rejects(validateImage(gif, 8 * MB), UserError);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="540" height="960"><script>alert(1)</script></svg>');
  await assert.rejects(validateImage(svg, 8 * MB), UserError);
  await assert.rejects(validateImage('texto', 8 * MB), UserError);
});
test('considera orientação EXIF (foto 1920x1080 com orientation=6 é vertical)', async () => {
  const rotated = await make(1920, 1080, 'jpeg', { meta: { orientation: 6 } });
  const info = await validateImage(rotated, 8 * MB);
  assert.equal(info.width, 1080); assert.equal(info.height, 1920);
  const flat = await make(1920, 1080, 'jpeg', { meta: { orientation: 1 } });
  await assert.rejects(validateImage(flat, 8 * MB), /9:16/);
});

const response = (body, init = {}) => new Response(body, init);
const att = (over = {}) => ({ url: 'https://cdn.discordapp.com/attachments/1/2/foto.jpg', size: 1000, ...over });

test('downloadAttachment: só hosts oficiais do Discord via https', async () => {
  for (const url of ['http://cdn.discordapp.com/x.jpg', 'https://evil.com/x.jpg', 'https://cdn.discordapp.com.evil.com/x.jpg', 'https://169.254.169.254/latest', 'nao-url', 'file:///etc/passwd']) {
    await assert.rejects(downloadAttachment(att({ url }), { maxBytes: MB, fetchImpl: async () => { throw new Error('não deveria buscar'); } }), UserError, url);
  }
});
test('downloadAttachment: respeita limites de tamanho (declarado e real) e erros HTTP', async () => {
  await assert.rejects(downloadAttachment(att({ size: 5 * MB }), { maxBytes: MB, fetchImpl: async () => response('x') }), /limite/);
  await assert.rejects(downloadAttachment(att(), { maxBytes: 10, fetchImpl: async () => response('x'.repeat(100)) }), /limite/);
  await assert.rejects(downloadAttachment(att(), { maxBytes: MB, fetchImpl: async () => response('', { status: 404 }) }), /baixar/);
  await assert.rejects(downloadAttachment(att(), { maxBytes: MB, fetchImpl: async () => { throw new Error('rede'); } }), /baixar/);
  const ok = await downloadAttachment(att(), { maxBytes: MB, fetchImpl: async () => response('abc') });
  assert.equal(ok.toString(), 'abc');
});
test('downloadAttachment: usa timeout e não segue redirecionamentos', async () => {
  let init;
  await downloadAttachment(att(), { maxBytes: MB, timeoutMs: 5000, fetchImpl: async (_u, i) => { init = i; return response('a'); } });
  assert.equal(init.redirect, 'error'); assert.ok(init.signal instanceof AbortSignal);
});
test('Storage: upload usa UUID no caminho, remoção não lança e download falha com UserError', async () => {
  const db = createFakeDb();
  const path = await uploadPhoto(db, 'model-photos', 'g1', Buffer.from('x'), { mime: 'image/jpeg', ext: 'jpg' });
  assert.match(path, /^g1\/[0-9a-f-]{36}\.jpg$/);
  assert.equal((await downloadPhoto(db, 'model-photos', path)).toString(), 'x');
  db.failNext('storage', 'remove');
  assert.equal(await removePhoto(db, 'model-photos', path), false); // erro engolido e registrado em log
  assert.equal(await removePhoto(db, 'model-photos', path), true);
  assert.equal(await removePhoto(db, 'model-photos', null), false);
  await assert.rejects(downloadPhoto(db, 'model-photos', 'nao/existe.jpg'), UserError);
  db.failNext('storage', 'upload');
  await assert.rejects(uploadPhoto(db, 'model-photos', 'g1', Buffer.from('x'), { mime: 'image/png', ext: 'png' }));
});
