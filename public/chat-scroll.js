export function isNearBottom(container, threshold = 150) {
  if (!container) return false;
  return container.scrollHeight - container.scrollTop - container.clientHeight <= threshold;
}

export function scrollToBottom(container) {
  if (!container) return;
  container.scrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
}

export function shouldSettleAtBottom({ conversationChanged, hasMessages, wasNearBottom }) {
  return Boolean((conversationChanged && hasMessages) || wasNearBottom);
}

export function settleAtBottom(container, scheduleFrame = (callback) => requestAnimationFrame(callback)) {
  if (!container) return;
  scrollToBottom(container);
  scheduleFrame(() => {
    scrollToBottom(container);
    scheduleFrame(() => scrollToBottom(container));
  });
}
