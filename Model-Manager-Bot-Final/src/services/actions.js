import { record } from './logchannel.js';
import { getSettings } from '../security/permissions.js';
import { downloadAttachment, validateImage, uploadPhoto, removePhoto } from './images.js';
import { deleteModel, getSecrets, requireModel, setFeaturedFlag, updateModel, updateSecrets } from './models.js';
import { publishFeatured, publishModel, removeFeatured, removePublications, syncPublications } from './publisher.js';
import { UserError } from '../utils/errors.js';
import { validateEdit } from '../utils/validators.js';
import { logger } from '../utils/logger.js';

/** Fluxos de negócio compartilhados por comandos slash, botões e modais. */

export async function editField(ctx, interaction, identifier, field, rawValue) {
  const value = validateEdit(field, rawValue);
  const model = await requireModel(ctx.db, interaction.guildId, identifier);
  const updated = await updateModel(ctx.db, interaction.guildId, model.id, { [field]: value });
  await record(ctx, interaction, 'model_updated', model.id, { field });
  const settings = await getSettings(ctx.db, interaction.guildId);
  const warnings = await syncPublications(ctx, settings, updated);
  return { model: updated, warnings };
}

export async function replacePhoto(ctx, interaction, identifier, attachment) {
  const model = await requireModel(ctx.db, interaction.guildId, identifier);
  const buffer = await downloadAttachment(attachment, { maxBytes: ctx.config.maxImageBytes, timeoutMs: ctx.config.externalTimeoutMs });
  const info = await validateImage(buffer, ctx.config.maxImageBytes);
  const newPath = await uploadPhoto(ctx.db, ctx.config.bucket, interaction.guildId, buffer, info);
  let updated;
  try {
    updated = await updateModel(ctx.db, interaction.guildId, model.id, { photo_path: newPath });
  } catch (error) {
    await removePhoto(ctx.db, ctx.config.bucket, newPath); // não deixa arquivo órfão
    throw error;
  }
  await removePhoto(ctx.db, ctx.config.bucket, model.photo_path); // só depois do banco apontar para a nova
  await record(ctx, interaction, 'model_photo_replaced', model.id);
  const settings = await getSettings(ctx.db, interaction.guildId);
  const warnings = await syncPublications(ctx, settings, updated);
  return { model: updated, warnings };
}

/** Liga/desliga destaque. Em caso de falha na publicação, reverte o flag para manter consistência. */
export async function toggleFeature(ctx, interaction, identifier) {
  const model = await requireModel(ctx.db, interaction.guildId, identifier);
  const settings = await getSettings(ctx.db, interaction.guildId);
  const enable = !model.is_featured;
  if (enable && !settings?.featured_channel_id) throw new UserError('Canal de destaques não configurado. Use /painel.');
  const updated = await setFeaturedFlag(ctx.db, interaction.guildId, model.id, enable);
  const warnings = [];
  try {
    if (enable) await publishFeatured(ctx, settings, updated);
    else await removeFeatured(ctx, settings, model);
  } catch (error) {
    if (enable) { // não deixa a modelo "em destaque" sem mensagem publicada
      await setFeaturedFlag(ctx.db, interaction.guildId, model.id, false).catch((e) => logger.error('Falha ao reverter destaque.', e));
    }
    throw error;
  }
  const fresh = await requireModel(ctx.db, interaction.guildId, model.id);
  try { await publishModel(ctx, settings, fresh); } catch (error) {
    warnings.push(error instanceof UserError ? error.message : 'Não foi possível atualizar a ficha pública.');
  }
  await record(ctx, interaction, enable ? 'model_featured' : 'model_unfeatured', model.id);
  return { featured: enable, warnings };
}

export async function republish(ctx, interaction, identifier) {
  const model = await requireModel(ctx.db, interaction.guildId, identifier);
  const settings = await getSettings(ctx.db, interaction.guildId);
  await publishModel(ctx, settings, model);
  if (model.is_featured && settings?.featured_channel_id) await publishFeatured(ctx, settings, model);
  await record(ctx, interaction, 'model_republished', model.id);
  return model;
}

/** Exclusão: apaga publicações (best-effort) e o registro; falha de Storage não impede a exclusão. */
export async function removeModel(ctx, interaction, identifier) {
  const model = await requireModel(ctx.db, interaction.guildId, identifier);
  const settings = await getSettings(ctx.db, interaction.guildId);
  const { storageRemoved } = await deleteModel(ctx.db, interaction.guildId, model, ctx.config.bucket);
  await removePublications(ctx, settings, model);
  await record(ctx, interaction, 'model_deleted', model.id, { storage_cleanup: storageRemoved ? 'ok' : 'failed' });
  return { model, storageRemoved };
}

/** Auditoria é OBRIGATÓRIA e ocorre antes de revelar credenciais (falha de auditoria nega o acesso). */
export async function revealCredentials(ctx, interaction, identifier) {
  const model = await requireModel(ctx.db, interaction.guildId, identifier);
  await record(ctx, interaction, 'credentials_viewed', model.id, {}, { required: true });
  const secrets = await getSecrets(ctx.db, interaction.guildId, model.id, ctx.config.masterKey);
  return { model, secrets };
}

export async function changePasswords(ctx, interaction, identifier, passwords) {
  const model = await requireModel(ctx.db, interaction.guildId, identifier);
  const changed = await updateSecrets(ctx.db, interaction.guildId, model.id, ctx.config.masterKey, passwords);
  await record(ctx, interaction, 'credentials_updated', model.id, { platforms: changed });
  return { model, changed };
}
