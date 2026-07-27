import type { EthosNotification } from '../ethos/notifications';

type NotificationValue = Record<string, unknown>;

export interface FormattedXpSummary {
  totalXp: number;
  xpStreakDays: number;
}

export interface FormattedRewardSummary {
  vouchPoolReward: number;
  votePoolReward: number;
  commentPoolReward: number;
  marketHoldPoolReward: number;
  marketTradePoolReward: number;
  delegationReward: number;
  slashReward: number;
  dailyStreakReward: number;
  otherReward: number;
}

function isObject(value: unknown): value is NotificationValue {
  return typeof value === 'object' && value !== null;
}

function readPath(source: unknown, path: readonly string[]): unknown {
  let current: unknown = source;

  for (const segment of path) {
    if (!isObject(current) || !(segment in current)) {
      return undefined;
    }

    current = current[segment];
  }

  return current;
}

function pickString(source: unknown, paths: readonly (readonly string[])[], fallback: string): string {
  for (const path of paths) {
    const value = readPath(source, path);
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return fallback;
}

function pickNumberText(source: unknown, paths: readonly (readonly string[])[], fallback: string): string {
  for (const path of paths) {
    const value = readPath(source, path);
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }

    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return fallback;
}

function formatIdentity(value: string): string {
  if (value.startsWith('@') || value.includes(' ')) {
    return value;
  }

  // Heuristic: only add '@' to strings that look like handles (lowercase alphanumeric)
  // Standard full names typically have spaces or mixed case.
  if (/^[a-z0-9_]{3,}$/.test(value)) {
    return `@${value}`;
  }

  return value;
}

function getNotificationEventLabel(notification: EthosNotification): string {
  switch (notification.type) {
    case 'SLASH_CREATE':
    case 'SLASH_COMPLETE':
      return 'Slash';
    case 'REVIEW':
      return 'Review';
    case 'REPLY':
      return 'Reply';
    case 'VOUCH':
      return 'Vouch';
    case 'VOUCH_COMMENT':
      return 'Vouch Comment';
    default:
      return notification.title ?? 'Activity';
  }
}

function getActorName(notification: EthosNotification): string {
  return pickString(
    notification,
    [
      ['metadata', 'author', 'displayName'],
      ['metadata', 'author', 'name'],
      ['metadata', 'author', 'username'],
      ['metadata', 'author', 'xUsername'],
      ['metadata', 'actor', 'displayName'],
      ['metadata', 'actor', 'name'],
      ['metadata', 'actor', 'username'],
      ['metadata', 'actor', 'xUsername'],
      ['metadata', 'user', 'displayName'],
      ['metadata', 'user', 'name'],
      ['metadata', 'user', 'username'],
      ['metadata', 'user', 'xUsername'],
      ['metadata', 'fromUser', 'displayName'],
      ['metadata', 'fromUser', 'name'],
      ['metadata', 'fromUser', 'username'],
      ['metadata', 'fromUser', 'xUsername'],
      ['metadata', 'sender', 'displayName'],
      ['metadata', 'sender', 'name'],
      ['metadata', 'sender', 'username'],
      ['metadata', 'sender', 'xUsername'],
    ],
    'unknown',
  );
}

function getTargetName(notification: EthosNotification): string {
  return pickString(
    notification,
    [
      ['metadata', 'target', 'displayName'],
      ['metadata', 'target', 'name'],
      ['metadata', 'target', 'username'],
      ['metadata', 'target', 'xUsername'],
      ['metadata', 'subject', 'displayName'],
      ['metadata', 'subject', 'name'],
      ['metadata', 'subject', 'username'],
      ['metadata', 'subject', 'xUsername'],
      ['metadata', 'profile', 'displayName'],
      ['metadata', 'profile', 'name'],
      ['metadata', 'profile', 'username'],
      ['metadata', 'profile', 'xUsername'],
      ['metadata', 'toUser', 'displayName'],
      ['metadata', 'toUser', 'name'],
      ['metadata', 'toUser', 'username'],
      ['metadata', 'toUser', 'xUsername'],
    ],
    'unknown',
  );
}

function getComment(notification: EthosNotification): string {
  return pickString(
    notification,
    [
      ['metadata', 'comment'],
      ['metadata', 'review', 'comment'],
      ['metadata', 'reply', 'text'],
      ['metadata', 'text'],
      ['body'],
    ],
    'No comment provided.',
  );
}

function formatWeiAmount(value: string): string {
  if (!/^\d+$/.test(value)) {
    return value;
  }

  const wei = BigInt(value);
  const divisor = 10n ** 18n;
  const whole = wei / divisor;
  const fraction = wei % divisor;

  if (fraction === 0n) {
    return `${whole.toString()} ETH`;
  }

  let fractionText = fraction.toString().padStart(18, '0').replace(/0+$/, '');
  fractionText = fractionText.slice(0, 6).replace(/0+$/, '');

  if (!fractionText) {
    return `${whole.toString()} ETH`;
  }

  return `${whole.toString()}.${fractionText} ETH`;
}

function getAmount(notification: EthosNotification): string {
  const rawAmount = pickNumberText(
    notification,
    [
      ['metadata', 'amount'],
      ['metadata', 'vouch', 'amount'],
      ['metadata', 'stakeAmount'],
      ['metadata', 'value'],
    ],
    '0',
  );

  if (/^\d+$/.test(rawAmount) && rawAmount.length >= 10) {
    return formatWeiAmount(rawAmount);
  }

  const numericAmount = Number(rawAmount);
  if (Number.isFinite(numericAmount)) {
    return `${numericAmount} ETH`;
  }

  return rawAmount;
}

function getEventLink(notification: EthosNotification): string | null {
  const value = pickString(
    notification,
    [
      ['metadata', 'link'],
      ['metadata', 'eventLink'],
      ['metadata', 'url'],
    ],
    '',
  );

  return value || null;
}

function getReviewSentiment(notification: EthosNotification): string {
  const rawScore = Number(
    pickNumberText(
      notification,
      [
        ['metadata', 'score'],
        ['metadata', 'review', 'score'],
        ['metadata', 'rating'],
      ],
      '0',
    ),
  );

  if (rawScore > 0) {
    return 'Positive';
  }

  if (rawScore < 0) {
    return 'Negative';
  }

  return 'Neutral';
}

function trimComment(value: string, maxLength: number = 220): string {
  const normalized = value.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

export function formatSlashNotification(notification: EthosNotification): string {
  const titleText = notification.title ? `\n📌 <b>${notification.title}</b>` : '';
  const lines = [
    `Slash detected${titleText}`,
    '',
    `🛡️ User: ${formatIdentity(getTargetName(notification))}`,
    `⚔️ From: ${formatIdentity(getActorName(notification))}`,
  ];

  const comment = getComment(notification);
  if (comment !== 'No comment provided.') {
    lines.push('', trimComment(comment));
  }

  const eventLink = getEventLink(notification);
  if (eventLink) {
    lines.push('', `Event: ${eventLink}`);
  }

  return lines.join('\n');
}

export function formatGlobalSlashNotification(notification: EthosNotification): string {
  const titleText = notification.title ? `\n📌 <b>${notification.title}</b>` : '';
  const lines = [
    `🚨 Global Slash Alert 🚨${titleText}`,
    '',
    `🛡️ User: ${formatIdentity(getTargetName(notification))}`,
    `⚔️ From: ${formatIdentity(getActorName(notification))}`,
  ];

  const comment = getComment(notification);
  if (comment !== 'No comment provided.') {
    lines.push('', trimComment(comment));
  }

  const eventLink = getEventLink(notification);
  if (eventLink) {
    lines.push('', `Event: ${eventLink}`);
  }

  return lines.join('\n');
}

export function formatReviewNotification(notification: EthosNotification): string {
  const lines = [
    '📝 New Review',
    '',
    `👤 For: ${formatIdentity(getTargetName(notification))}`,
    `📝 From: ${formatIdentity(getActorName(notification))}`,
    `⭐ Sentiment: ${getReviewSentiment(notification)}`,
    '',
    trimComment(getComment(notification)),
  ];

  const eventLink = getEventLink(notification);
  if (eventLink) {
    lines.push('', `Event: ${eventLink}`);
  }

  return lines.join('\n');
}

export function formatReplyNotification(notification: EthosNotification): string {
  return [
    '💬 New Reply',
    '',
    `✍️ From: ${formatIdentity(getActorName(notification))}`,
    '',
    trimComment(getComment(notification)),
  ].join('\n');
}

export function formatVouchNotification(notification: EthosNotification): string {
  const lines = [
    '🤝 New Vouch',
    '',
    `👤 For: ${formatIdentity(getTargetName(notification))}`,
    `🤝 From: ${formatIdentity(getActorName(notification))}`,
    `💰 Amount: ${getAmount(notification)}`,
  ];

  const eventLink = getEventLink(notification);
  if (eventLink) {
    lines.push('', `Event: ${eventLink}`);
  }

  return lines.join('\n');
}

export function formatVouchCommentNotification(notification: EthosNotification): string {
  return [
    '💬 New Vouch Comment',
    '',
    `✍️ From: ${formatIdentity(getActorName(notification))}`,
    '',
    trimComment(getComment(notification)),
  ].join('\n');
}

export function formatWatchedNotification(notification: EthosNotification): string {
  switch (notification.type) {
    case 'REVIEW':
      return [
        '👀 Watched Profile: New Review',
        '',
        `👤 User: ${formatIdentity(getTargetName(notification))}`,
        `📝 From: ${formatIdentity(getActorName(notification))}`,
        `⭐ Sentiment: ${getReviewSentiment(notification)}`,
        '',
        trimComment(getComment(notification)),
        ...(getEventLink(notification) ? ['', `Event: ${getEventLink(notification)}`] : []),
      ].join('\n');
    case 'VOUCH':
      return [
        '👀 Watched Profile: New Vouch',
        '',
        `👤 User: ${formatIdentity(getTargetName(notification))}`,
        `🤝 From: ${formatIdentity(getActorName(notification))}`,
        `💰 Amount: ${getAmount(notification)}`,
        ...(getEventLink(notification) ? ['', `Event: ${getEventLink(notification)}`] : []),
      ].join('\n');
    case 'SLASH_CREATE':
    case 'SLASH_COMPLETE': {
      const slashIdText = notification.slashId ? ` - #${notification.slashId}` : '';
      return [
        `👀 Watched Profile: Slash${slashIdText}`,
        '',
        `🛡️ User: ${formatIdentity(getTargetName(notification))}`,
        `⚔️ From: ${formatIdentity(getActorName(notification))}`,
        ...(getComment(notification) !== 'No comment provided.'
          ? ['', trimComment(getComment(notification))]
          : []),
        ...(getEventLink(notification) ? ['', `Event: ${getEventLink(notification)}`] : []),
      ].join('\n');
    }
    default:
      return [
        '👀 Watched profile activity',
        '',
        `👤 User: ${formatIdentity(getTargetName(notification))}`,
        `📌 Event: ${getNotificationEventLabel(notification)}`,
      ].join('\n');
  }
}

export function formatNotificationMessage(notification: EthosNotification): string {
  switch (notification.type) {
    case 'SLASH_CREATE':
    case 'SLASH_COMPLETE':
      return formatSlashNotification(notification);
    case 'REVIEW':
      return formatReviewNotification(notification);
    case 'REPLY':
      return formatReplyNotification(notification);
    case 'VOUCH':
      return formatVouchNotification(notification);
    case 'VOUCH_COMMENT':
      return formatVouchCommentNotification(notification);
    default: {
      const title = notification.title ?? 'New Ethos activity';
      const body = notification.body ?? 'You have a new profile update.';
      return `${title}\n${body}`;
    }
  }
}

export function formatXpMessage(xp: FormattedXpSummary): string {
  return [
    'XP summary',
    '',
    `Total XP: ${xp.totalXp}`,
    `Contribution streak: ${xp.xpStreakDays} days`,
  ].join('\n');
}

export function formatRewardSummary(rewards: FormattedRewardSummary): string {
  const lines: string[] = [];

  const rewardTypes = [
    { key: 'marketTradePoolReward', label: 'Market trading', icon: '📈' },
    { key: 'vouchPoolReward', label: 'Vouching', icon: '🤝' },
    { key: 'votePoolReward', label: 'Voting', icon: '🗳️' },
    { key: 'marketHoldPoolReward', label: 'Market holding', icon: '💎' },
    { key: 'commentPoolReward', label: 'Commenting', icon: '💬' },
    { key: 'delegationReward', label: 'Delegation', icon: '🛡️' },
    { key: 'slashReward', label: 'Slash bounty', icon: '⚔️' },
    { key: 'dailyStreakReward', label: 'Daily task', icon: '🔥' },
    { key: 'otherReward', label: 'Other', icon: '🎁' },
  ] as const;

  for (const { key, label, icon } of rewardTypes) {
    const value = (rewards as any)[key];
    if (value > 0) {
      lines.push(`${icon} ${label} reward: +${value} XP`);
    }
  }

  return lines.join('\n');
}

export function formatProfileSummary(profile: {
  username: string;
  profileId: string;
  totalXp: number;
  positiveReviewPercent: number;
  verified: boolean;
  isValidator: boolean;
  validatorRank: number | null;
  score: number;
  influenceFactor: number;
  slashCount: number;
  reviewCount: number;
  receivedVouchCount: number;
  givenVouchCount: number;
  rank: number | null;
  categoryRanks?: Array<{ rank: number, name: string }>;
}): string {
  const n = (value: number) => value.toLocaleString('en-US');

  const lines = [
    '👤 <b>Ethos profile</b>',
    `Profile ID: ${profile.profileId}`,
    '',
    `✅ Verified: ${profile.verified ? 'yes' : 'no'}`,
    `🏅 Score: ${n(profile.score)}`,
    `🔥 XP: ${n(profile.totalXp)}${profile.rank ? ` (Rank #${n(profile.rank)})` : ''}`,
    `⭐ Reputation: ${profile.positiveReviewPercent}%`,
    `📈 Influence: ${n(profile.influenceFactor)}`,
    `🛡️ Validator: ${profile.isValidator ? 'yes' : 'no'}`,
    `⚔️ Slashed: ${profile.slashCount > 0 ? `yes (${profile.slashCount})` : 'no'}`,
    '',
    '<b>Highlights</b>',
    `📝 Reviews: ${n(profile.reviewCount)}`,
    `👍 Positive reviews: ${profile.positiveReviewPercent}%`,
    `🤝 Vouches received: ${n(profile.receivedVouchCount)}`,
    `📤 Vouches given: ${n(profile.givenVouchCount)}`,
  ];

  if (profile.categoryRanks && profile.categoryRanks.length > 0) {
    lines.push('');
    lines.push(profile.categoryRanks.map((category) => `🏆 #${Math.round(category.rank)} ${category.name}`).join(' | '));
  }

  return lines.join('\n');
}
