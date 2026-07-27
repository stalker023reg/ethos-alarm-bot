import { getTelegramMediaCache, upsertTelegramMediaCache } from '../db/db';
import { logger } from '../utils/logger';

type ReplyWithPhotoExtra = Record<string, unknown> | undefined;

type ReplyWithPhotoContext = {
  replyWithPhoto: (photo: string | { url: string }, extra?: ReplyWithPhotoExtra) => Promise<any>;
};

function buildProfileCardCacheKey(profileId: string): string {
  const today = new Date().toISOString().split('T')[0];
  return `ethos-profile-card:${profileId}:${today}`;
}

function buildProfileCardUrl(profileId: string): string {
  const today = new Date().toISOString().split('T')[0];
  return `https://app.ethos.network/og/profile-cards/profileId:${profileId}?v=${today}`;
}

function extractPhotoFileId(message: any): string | null {
  const photos = message?.photo;

  if (!Array.isArray(photos) || photos.length === 0) {
    return null;
  }

  const largestPhoto = photos[photos.length - 1];
  return typeof largestPhoto?.file_id === 'string' && largestPhoto.file_id.trim()
    ? largestPhoto.file_id
    : null;
}

export async function sendProfileCardPhoto(
  ctx: ReplyWithPhotoContext,
  profileId: string,
  extra?: ReplyWithPhotoExtra,
): Promise<void> {
  const cacheKey = buildProfileCardCacheKey(profileId);
  const cachedFileId = await getTelegramMediaCache(cacheKey);

  if (cachedFileId) {
    try {
      await ctx.replyWithPhoto(cachedFileId, extra);
      return;
    } catch (error) {
      logger.warn('Failed to reuse cached Telegram media, falling back to source URL', {
        cacheKey,
        profileId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const message = await ctx.replyWithPhoto({ url: buildProfileCardUrl(profileId) }, extra);
  const fileId = extractPhotoFileId(message);

  if (!fileId) {
    return;
  }

  try {
    await upsertTelegramMediaCache(cacheKey, fileId);
  } catch (error) {
    logger.warn('Failed to cache Telegram media file_id', {
      cacheKey,
      profileId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
