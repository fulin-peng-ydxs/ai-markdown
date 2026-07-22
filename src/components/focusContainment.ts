interface FocusContainmentEvent {
  key: string;
  shiftKey: boolean;
  preventDefault(): void;
}

const FOCUSABLE_SELECTOR = [
  "button:not(:disabled)",
  "[href]",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hidden && element.getAttribute("aria-hidden") !== "true",
  );
}

export function focusContainmentEntry(container: HTMLElement) {
  if (container.contains(document.activeElement)) {
    return;
  }
  const autofocus = container.querySelector<HTMLElement>("[autofocus]");
  (autofocus ?? focusableElements(container)[0] ?? container).focus();
}

export function containTabFocus(event: FocusContainmentEvent, container: HTMLElement) {
  if (event.key !== "Tab") {
    return;
  }
  const focusable = focusableElements(container);
  if (focusable.length === 0) {
    event.preventDefault();
    container.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && (document.activeElement === first || !container.contains(document.activeElement))) {
    event.preventDefault();
    last.focus();
    return;
  }
  if (!event.shiftKey && (document.activeElement === last || !container.contains(document.activeElement))) {
    event.preventDefault();
    first.focus();
  }
}

export function restoreFocus(element: HTMLElement | null) {
  if (element?.isConnected) {
    element.focus();
  }
}
