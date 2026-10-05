// Demo mode: creates a sandboxed demo user with sample data for prospective users to try Orbit Buddy.
import { randomUUID } from 'node:crypto';

const DEMO_MESSAGE_CAP = 20;
const DEMO_MAX_AGE_MS = 60 * 60_000; // 1 hour

const SAMPLE_MEMORIES = [
  { content: 'Training for a 5K race in November. Currently running about 2 miles comfortably.', kind: 'goal' },
  { content: 'Studying for the CompTIA Security+ certification exam.', kind: 'goal' },
  { content: 'Favorite coffee order is a cold brew with oat milk.', kind: 'preference' },
  { content: 'Prefers morning briefings with weather and calendar highlights.', kind: 'preference' },
];

const SAMPLE_GOALS = [
  { title: 'Run a 5K', description: 'Build up from 2 miles to 3.1 miles by November.', progress: 35 },
  { title: 'Pass CompTIA Security+', description: 'Study an hour a day, take practice exams on weekends.', progress: 60 },
];

const SAMPLE_TASKS = [
  { title: 'Call mom about weekend plans', prompt: '' },
  { title: 'Buy new running shoes', prompt: '' },
  { title: 'Review Security+ practice exam results', prompt: '' },
];

const STARTER_MESSAGES = [
  { role: 'user', content: 'Hey! What can you help me with?' },
  { role: 'assistant', content: 'Hey there! I can help with all sorts of things — check the weather, do quick math, search the web, track your goals and tasks, set reminders, and lots more. I also learn your preferences over time so I get more helpful the more we chat. What would you like to try first?' },
  { role: 'user', content: "What's the weather like today?" },
  { role: 'assistant', content: 'I\'d check that for you with live data! In this demo I don\'t have your location set up, but in the full app I\'d pull your local forecast instantly. Try asking me to do some math, or tell me about one of your goals!' },
];

export function seedDemoData(db, userId) {
  const now = new Date().toISOString();
  // Memories
  for (const m of SAMPLE_MEMORIES) {
    db.addMemory(userId, m.content, { kind: m.kind, source: 'demo' });
  }
  // Goals
  for (const g of SAMPLE_GOALS) {
    const goal = db.addGoal(userId, { title: g.title, description: g.description });
    db.updateGoal(userId, goal.id, { progress: g.progress });
  }
  // Tasks
  for (const t of SAMPLE_TASKS) {
    db.addTask(userId, { title: t.title, prompt: t.prompt });
  }
  // Starter conversation
  const convo = db.ensureDefaultConversation(userId);
  for (const msg of STARTER_MESSAGES) {
    db.addMessage(userId, convo.id, msg.role, msg.content);
  }
  db.addEvent(userId, 'demo_started', 'Started a demo session.');
}

export function isDemoUser(user) {
  return user && user.is_demo === 1;
}

export function demoMessageCount(db, userId) {
  const count = db.countUserMessages(userId);
  // Subtract the 2 starter user messages so the cap counts only their real messages
  return Math.max(0, count - 2);
}

export function demoCapReached(db, userId) {
  return demoMessageCount(db, userId) >= DEMO_MESSAGE_CAP;
}

export function cleanupExpiredDemos(db) {
  const expired = db.listExpiredDemoUsers(DEMO_MAX_AGE_MS);
  for (const { id } of expired) {
    try { db.deleteDemoUser(id); } catch {}
  }
  return expired.length;
}

export { DEMO_MESSAGE_CAP, DEMO_MAX_AGE_MS };
