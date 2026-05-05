import blessed, { type Widgets } from "blessed";
import { bold, fg, toneTag, truncate, UI_THEME } from "./theme";

export interface ActionModalLayout {
  height: number;
  left: number;
  top: number;
  width: number;
}

export interface ActionModalOptions {
  cancelLabel?: string;
  closeKeys?: string[];
  confirmLabel?: string;
  initialValue?: string;
  inputLabel?: string;
  message: string;
  mode?: "action" | "info";
  onCancel(): void;
  onConfirm(value: string): void;
  screen: Widgets.Screen;
  title: string;
  validate?(value: string): string | null;
}

export interface ActionModalController {
  cancel(): void;
  destroy(options?: { notify?: boolean; render?: boolean }): void;
  handleKeypress(ch: string | undefined, key: blessed.Widgets.Events.IKeyEventArg): boolean;
  resize(): void;
  submit(): void;
}

const ACTION_MODAL_SCREEN_RATIO = 0.68;
type ActionButton = "cancel" | "confirm";

const ACTION_MODAL_MIN_HEIGHT = {
  action: {
    confirm: 10,
    input: 12,
  },
  info: 6,
} as const;

export function calculateActionModalLayout(
  screenWidth: number,
  screenHeight: number,
  hasInput: boolean,
  message = "",
  mode: "action" | "info" = "action",
): ActionModalLayout {
  const boundedScreenWidth = Math.max(Math.floor(screenWidth), 1);
  const boundedScreenHeight = Math.max(Math.floor(screenHeight), 1);
  const width = Math.min(
    Math.max(Math.floor(boundedScreenWidth * ACTION_MODAL_SCREEN_RATIO), 44),
    Math.min(84, boundedScreenWidth),
  );
  const messageHeight = getWrappedLineCount(message, Math.max(width - 4, 1));
  const dynamicHeight = mode === "info"
    ? messageHeight + 4
    : hasInput
      ? messageHeight + 8
      : messageHeight + 5;
  const minimumHeight = mode === "info"
    ? ACTION_MODAL_MIN_HEIGHT.info
    : hasInput
      ? ACTION_MODAL_MIN_HEIGHT.action.input
      : ACTION_MODAL_MIN_HEIGHT.action.confirm;
  const height = Math.min(Math.max(dynamicHeight, minimumHeight), boundedScreenHeight);

  return {
    height,
    left: Math.max(Math.floor((boundedScreenWidth - width) / 2), 0),
    top: Math.max(Math.floor((boundedScreenHeight - height) / 2), 0),
    width,
  };
}

function buildBackdropContent(screenWidth: number, screenHeight: number): string {
  const width = Math.max(Math.floor(screenWidth), 1);
  const height = Math.max(Math.floor(screenHeight), 1);
  const line = " ".repeat(width);
  return Array.from({ length: height }, () => line).join("\n");
}

export function formatActionModalInputValue(value: string): string {
  return value ? `${value}_` : "_";
}

function getWrappedLineCount(text: string, width: number): number {
  const availableWidth = Math.max(width, 1);
  let total = 0;

  for (const rawLine of text.split("\n")) {
    if (rawLine.length === 0) {
      total += 1;
      continue;
    }

    let remaining = rawLine;
    while (remaining.length > availableWidth) {
      let breakIndex = remaining.lastIndexOf(" ", availableWidth);
      if (breakIndex <= 0) {
        breakIndex = availableWidth;
      }

      total += 1;
      remaining = remaining.slice(breakIndex).trimStart();
      if (remaining.length === 0) {
        break;
      }
      if (remaining.length <= availableWidth) {
        total += 1;
        remaining = "";
      }
    }

    if (remaining.length > 0 && remaining.length <= availableWidth) {
      total += 1;
    }
  }

  return Math.max(total, 1);
}

function centerText(value: string, width: number): string {
  const availableWidth = Math.max(width, value.length);
  const leftPadding = Math.floor((availableWidth - value.length) / 2);
  const rightPadding = availableWidth - value.length - leftPadding;
  return `${" ".repeat(leftPadding)}${value}${" ".repeat(rightPadding)}`;
}

function renderActionButton(
  label: string,
  {
    disabled = false,
    selected = false,
    width = label.length,
    tone = "info",
  }: {
    disabled?: boolean;
    selected?: boolean;
    width?: number;
    tone?: "danger" | "info";
  } = {},
): string {
  const content = `  ${centerText(label, width)}  `;

  if (disabled) {
    return `{${UI_THEME.buttonDisabledText}-fg}{${UI_THEME.buttonDisabledBackground}-bg}${content}{/}`;
  }

  if (selected) {
    const background = tone === "danger" ? UI_THEME.danger : UI_THEME.accent;
    return `{${UI_THEME.buttonSelectedText}-fg}{${background}-bg}${content}{/}`;
  }

  const foreground = tone === "danger" ? UI_THEME.danger : UI_THEME.text;
  return `{${foreground}-fg}${content}{/${foreground}-fg}`;
}

function renderInputLine(label: string, value: string): string {
  return `${fg(UI_THEME.tableHeader, `${label}:`)} ${formatActionModalInputValue(value)}`;
}

export function openActionModal(options: ActionModalOptions): ActionModalController {
  const {
    cancelLabel = "Cancel",
    closeKeys,
    confirmLabel = "Confirm",
    initialValue = "",
    inputLabel,
    message,
    mode = "action",
    onCancel,
    onConfirm,
    screen,
    title,
    validate,
  } = options;
  const hasInput = mode === "action" && Boolean(inputLabel);
  const hasButtons = mode === "action";
  const modalCloseKeys = new Set(closeKeys ?? (mode === "info" ? ["?", "enter", "escape", "q"] : ["escape"]));
  let closed = false;
  let errorMessage = "";
  let inputValue = initialValue;
  let selectedButton: ActionButton = "confirm";
  let layout = calculateActionModalLayout(Number(screen.width), Number(screen.height), hasInput, message, mode);

  const backdropBox = blessed.box({
    height: "100%",
    left: 0,
    mouse: false,
    top: 0,
    width: "100%",
  });

  const modalBox = blessed.box({
    border: "line",
    focusable: true,
    height: layout.height,
    label: ` ${title} `,
    left: layout.left,
    style: {
      border: { fg: UI_THEME.accent },
      fg: UI_THEME.text,
    },
    tags: true,
    top: layout.top,
    width: layout.width,
  });

  const messageBox = blessed.box({
    height: 1,
    left: 2,
    mouse: false,
    scrollable: false,
    tags: true,
    top: 1,
    width: Math.max(layout.width - 4, 1),
    wrap: true,
  });

  const inputBox = blessed.box({
    height: 1,
    hidden: !hasInput,
    left: 2,
    tags: true,
    top: 5,
    width: Math.max(layout.width - 4, 1),
  });

  const errorBox = blessed.box({
    height: 1,
    left: 2,
    tags: true,
    top: hasInput ? 6 : 5,
    width: Math.max(layout.width - 4, 1),
  });

  const buttonBox = blessed.box({
    align: "center",
    height: 1,
    left: 2,
    tags: true,
    top: hasInput ? 8 : 7,
    width: Math.max(layout.width - 4, 1),
  });

  modalBox.append(messageBox);
  if (hasInput) {
    modalBox.append(inputBox);
  }
  if (hasButtons) {
    modalBox.append(errorBox);
    modalBox.append(buttonBox);
  }

  const getValidationMessage = () => validate?.(inputValue) ?? null;
  const canConfirm = () => getValidationMessage() === null;

  const updateLayout = () => {
    layout = calculateActionModalLayout(Number(screen.width), Number(screen.height), hasInput, message, mode);
    const messageHeight = Math.max(getWrappedLineCount(message, Math.max(layout.width - 4, 1)), 1);
    const messageTop = 1;
    const inputTop = messageTop + messageHeight + 1;
    const errorTop = hasInput ? inputTop + 1 : messageTop + messageHeight + 1;
    const buttonTop = layout.height - 3;
    backdropBox.setContent(buildBackdropContent(Number(screen.width), Number(screen.height)));
    modalBox.top = layout.top;
    modalBox.left = layout.left;
    modalBox.width = layout.width;
    modalBox.height = layout.height;
    messageBox.top = messageTop;
    messageBox.height = hasButtons ? Math.max(buttonTop - messageTop - (hasInput ? 4 : 1), 1) : Math.max(layout.height - 4, 1);
    messageBox.width = Math.max(layout.width - 4, 1);
    if (hasInput) {
      inputBox.top = inputTop;
      inputBox.width = Math.max(layout.width - 4, 1);
      errorBox.top = errorTop;
      errorBox.width = Math.max(layout.width - 4, 1);
    }
    if (hasButtons) {
      if (!hasInput) {
        errorBox.top = errorTop;
        errorBox.width = Math.max(layout.width - 4, 1);
      }
      buttonBox.top = buttonTop;
      buttonBox.width = Math.max(layout.width - 4, 1);
    }
  };

  const updateContent = () => {
    const confirmEnabled = canConfirm();
    const buttonLabelWidth = Math.max(cancelLabel.length, confirmLabel.length);
    messageBox.setContent(mode === "info" ? message : bold(message));
    if (hasInput) {
      inputBox.setContent(renderInputLine(inputLabel ?? "Value", inputValue));
    }
    if (hasButtons) {
      errorBox.setContent(
        errorMessage
          ? `{${toneTag("error")}}${truncate(errorMessage, Math.max(layout.width - 4, 1)).trimEnd()}{/${toneTag("error")}}`
          : "",
      );
      buttonBox.setContent([
        renderActionButton(cancelLabel, {
          selected: selectedButton === "cancel",
          tone: "danger",
          width: buttonLabelWidth,
        }),
        renderActionButton(confirmLabel, {
          disabled: !confirmEnabled,
          selected: selectedButton === "confirm",
          width: buttonLabelWidth,
        }),
      ].join("      "));
    }
  };

  const destroy = ({
    notify = false,
    render = true,
  }: {
    notify?: boolean;
    render?: boolean;
  } = {}) => {
    if (closed) {
      return;
    }

    closed = true;
    modalBox.destroy();
    backdropBox.destroy();
    if (notify) {
      onCancel();
    }
    if (render) {
      screen.render();
    }
  };

  const cancel = () => {
    destroy({ notify: true });
  };

  const submit = () => {
    if (closed) {
      return;
    }

    if (selectedButton === "cancel") {
      cancel();
      return;
    }

    const nextError = validate?.(inputValue) ?? null;
    if (nextError) {
      errorMessage = nextError;
      updateContent();
      screen.render();
      return;
    }

    const value = inputValue;
    destroy({ notify: false, render: false });
    onConfirm(value);
  };

  const handleKeypress = (ch: string | undefined, key: blessed.Widgets.Events.IKeyEventArg): boolean => {
    if (closed) {
      return false;
    }

    if (key.name && modalCloseKeys.has(key.name)) {
      cancel();
      return true;
    }

    if (ch && modalCloseKeys.has(ch)) {
      cancel();
      return true;
    }

    if (!hasButtons) {
      return false;
    }

    if (key.name === "left" || (key.name === "tab" && key.shift)) {
      selectedButton = "cancel";
      updateContent();
      screen.render();
      return true;
    }

    if (key.name === "right" || key.name === "tab") {
      selectedButton = "confirm";
      updateContent();
      screen.render();
      return true;
    }

    if (key.name === "enter") {
      submit();
      return true;
    }

    if (!hasInput) {
      return false;
    }

    if (key.name === "backspace") {
      inputValue = inputValue.slice(0, -1);
      errorMessage = "";
      updateContent();
      screen.render();
      return true;
    }

    if (ch && !key.ctrl && !key.meta) {
      inputValue += ch;
      errorMessage = "";
      updateContent();
      screen.render();
      return true;
    }

    return false;
  };

  updateLayout();
  updateContent();
  screen.append(backdropBox);
  screen.append(modalBox);
  modalBox.focus();
  screen.render();

  return {
    cancel,
    destroy,
    handleKeypress,
    resize: () => {
      if (closed) {
        return;
      }
      updateLayout();
      updateContent();
      screen.render();
    },
    submit,
  };
}
