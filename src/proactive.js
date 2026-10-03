import { rankGoals, routineDue, todayInZone, validTimeZone } from './intelligence.js';

function lines(items, formatter, empty) {
  return items.length ? items.map(formatter).join('\n') : empty;
}

export function dueRoutines(routines, timeZone, nowMs = Date.now()) {
  return (routines || []).filter((routine) => routineDue(routine, timeZone, nowMs));
}

export function buildRoutinePrompt({ routine, timeZone, agenda = '', goals = [], tasks = [], followUps = [], nowMs = Date.now() }) {
  const zone = validTimeZone(timeZone);
  const date = todayInZone(zone, nowMs);
  const rankedGoals = rankGoals(goals, 4, date);
  const goalText = lines(rankedGoals, (goal) => {
    const target = goal.target_date ? `, target ${goal.target_date}` : '';
    const next = goal.next_step ? `, next step: ${goal.next_step}` : '';
    return `- ${goal.title} (${goal.progress}% complete, priority ${goal.priority}${target}${next})`;
  }, '- No active goals.');
  const taskText = lines(tasks.filter((task) => !['completed', 'cancelled', 'failed'].includes(task.status)).slice(0, 5),
    (task) => `- ${task.title} (${task.status}${task.schedule_at ? `, due ${task.schedule_at}` : ''})`, '- No open tasks.');
  const followUpText = lines(followUps.slice(0, 5),
    (item) => `- ${item.description} on ${item.due_date} (priority ${item.priority})`, '- No scheduled follow-ups.');
  const context = `Date: ${date}\nTimezone: ${zone}\n\nCalendar:\n${agenda || 'No calendar events found.'}\n\nActive goals:\n${goalText}\n\nOpen tasks:\n${taskText}\n\nFollow-ups:\n${followUpText}`;

  if (routine.kind === 'briefing') {
    return `Prepare today's concise personal briefing. Lead with what is time-sensitive, surface at most three priorities, identify calendar conflicts or deadlines, and finish with one realistic next step tied to the highest-priority active goal. Use only the context below; do not invent events or progress. Sound helpful, not managerial.\n\n${context}`;
  }
  if (routine.kind === 'reflection') {
    return `Write a short end-of-day reflection prompt. Mention one relevant active goal or open task and ask one thoughtful question that helps the user notice progress or choose tomorrow's next step. Use only the context below and do not claim work was completed.\n\n${context}`;
  }
  return `Complete this recurring personal routine: ${routine.prompt}\n\nUse the context below only when relevant. Do not invent events, progress, or completed actions.\n\n${context}`;
}
