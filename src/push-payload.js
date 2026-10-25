// Notification content may remain queued with a provider after logout or a
// device changes accounts. Keep every provider-facing payload non-sensitive;
// the app fetches the actual update after authentication when opened.
const VIEWS = new Set(['today', 'tasks', 'activity', 'safety']);

export function genericPushPayload(data) {
  const view = VIEWS.has(data?.view) ? data.view : 'today';
  return {
    title: 'Orbit',
    body: 'Open Orbit to see your update.',
    data: { view }
  };
}
