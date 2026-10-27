// X5 "Writes like you" — personal writing voice for Orbit Buddy.
//
// Privacy-first by design:
// - Learning is explicit opt-in only (chat command or the Safety toggle).
//   Nothing is learned silently or on a schedule.
// - Only a compact distilled style profile (3-6 sentences) is stored per
//   user. Full email bodies are read into memory to distill the profile and
//   are never persisted, never logged.
// - The profile + opt-in flag are deleted immediately on "forget how I write".
// - The profile is injected as a style instruction only in drafting contexts
//   (email replies, messages, copy), never as a permanent personality change
//   and never in normal chat.

import { listSentEmails } from './gmail.js';

export const SENT_SAMPLE_MAX = 30;
const MIN_SAMPLE_CHARS = 50;
const MAX_SAMPLE_CHARS = 1500;
const MAX_TOTAL_CHARS = 12000;
const MAX_PROFILE_CHARS = 1200;

// Forwarded-email markers: those aren't the user's own writing.
const FORWARD_MARKERS = [
  '---------- forwarded message',
  'begin forwarded message',
  'forwarded message',
  'original message'
];

function looksForwarded(text) {
  const head = String(text || '').slice(0, 600).toLowerCase();
  return FORWARD_MARKERS.some((marker) => head.includes(marker));
}

/**
 * Normalize one raw sent-email body into a usable writing sample.
 * Strips quoted reply lines, collapses whitespace. Returns '' when the
 * sample is unusable (too short, a forward, or empty).
 */
export function cleanSample(body) {
  const lines = String(body || '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => !line.startsWith('>')) // quoted replies aren't their voice
    .filter((line) => !/^\s*on .* wrote:\s*$/i.test(line)); // reply headers
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length < MIN_SAMPLE_CHARS) return '';
  if (looksForwarded(text)) return '';
  return text.slice(0, MAX_SAMPLE_CHARS);
}

/**
 * Turn a list of {body} email records into a compact array of sample
 * strings for the distillation prompt. Pure; keeps everything in memory.
 */
export function extractWritingSamples(emails) {
  const samples = [];
  let total = 0;
  for (const email of emails || []) {
    const sample = cleanSample(email?.body);
    if (!sample || total >= MAX_TOTAL_CHARS) continue;
    samples.push(sample);
    total += sample.length;
    if (samples.length >= SENT_SAMPLE_MAX) break;
  }
  return samples;
}

/**
 * Prompt for the one-shot distillation call: describe the user's writing
 * voice in 3-6 sentences. Pure.
 */
export function buildVoiceDistillPrompt(samples) {
  const joined = samples
    .map((sample, index) => `--- Sample ${index + 1} ---\n${sample}`)
    .join('\n\n');
  return [
    'You are distilling a person\'s personal writing voice from samples of emails they wrote.',
    'Describe their voice in 3-6 sentences covering: overall tone (formal, casual, warm, terse),',
    'typical sentence length and structure, how they open and close messages (greetings and sign-offs),',
    'and any distinctive quirks (humor, emoji use, abbreviations, formatting habits).',
    'Write in the second person ("You write..."). Describe only style, never the content or topics of the emails.',
    'Do not quote or paraphrase any email content. Do not include names, addresses, or other personal details.',
    '',
    'Email samples:',
    joined
  ].join('\n');
}

/**
 * Validate the model's distilled profile: trimmed, length-capped, non-empty.
 * Returns the clean profile string, or '' when unusable.
 */
export function parseVoiceProfile(text) {
  const profile = String(text || '').trim().replace(/\s+/g, ' ');
  if (profile.length < 40) return '';
  return profile.slice(0, MAX_PROFILE_CHARS);
}

/**
 * Build the style instruction injected into the model context when the user
 * asks Orbit to draft something. Drafting-only: normal chat is untouched.
 */
export function buildVoiceStyleDirective(profile, userName) {
  const name = String(userName || '').trim() || 'the user';
  return [
    `When ${name} asks you to draft, write, or rewrite something for them — an email, reply, message, App Store copy, letter, or post — write it in their personal voice:`,
    profile,
    'Apply this voice only to the drafted writing itself. In normal conversation, keep your usual voice.'
  ].join('\n');
}

/**
 * Full learning flow: read up to SENT_SAMPLE_MAX recent sent emails via the
 * Gmail API, distill a compact voice profile with the model, and store it
 * (learning is itself the explicit opt-in). Email bodies stay in memory only.
 *
 * @param {{db, userId, getToken, model}} deps — model is a createModelClient result
 * @returns {{learned: true, sampleCount: number, updatedAt: string}}
 * @throws Error when Gmail is unavailable, no usable samples exist, or the
 *   model cannot distill a profile.
 */
export async function learnWritingVoice({ db, userId, getToken, model, maxSamples = SENT_SAMPLE_MAX }) {
  const { emails } = await listSentEmails(getToken, { max: maxSamples });
  const samples = extractWritingSamples(emails);
  if (samples.length < 3) {
    throw new Error(`Only found ${samples.length} usable sent email(s). Write and send a few more emails first, then try again.`);
  }
  const { text } = await model.respond({
    aiConsentUserId: userId,
    message: buildVoiceDistillPrompt(samples),
    tools: false,
    taskMode: true
  });
  const profile = parseVoiceProfile(text);
  if (!profile) throw new Error('Could not distill a writing profile from those emails. Try again with more sent mail.');
  db.setWritingVoiceProfile(userId, profile);
  db.addEvent(userId, 'writing_voice_learned', `Learned a personal writing voice from ${samples.length} sent emails.`);
  const state = db.getWritingVoice(userId);
  return { learned: true, sampleCount: samples.length, updatedAt: state.updatedAt };
}

/** Status for the Safety UI / API: never includes the profile text itself. */
export function writingVoiceStatus(db, userId) {
  const state = db.getWritingVoice(userId);
  return { optIn: Boolean(state.optIn), learned: Boolean(state.profile), updatedAt: state.updatedAt || null };
}
