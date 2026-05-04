import blessed, { type Widgets } from "blessed";
import { bold, fg, muted, toneTag, truncate, UI_THEME } from "./theme";

export interface ActionModalLayout {
  height: number;
  left: number;
  top: number;
  width: number;
}

export interface ActionModalOptions {
  cancelLabel?: string;
  confirmLabel?: string;
  initialValue?: string;
  inputLabel?: string;
  message: string;
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

export function calculateActionModalLayout(
  screenWidth: number,
  screenHeight: number,
  hasInput: boolean,
): ActionModalLayout {
  const boundedScreenWidth = Math.max(Math.floor(screenWidth), 1);
  const boundedScreenHeight = Math.max(Math.floor(screenHeight), 1);
  const width = Math.min(
    Math.max(Math.floor(boundedScreenWidth * ACTION_MODAL_SCREEN_RATIO), 44),
    Math.min(84, boundedScreenWidth),
  );
  const height = Math.min(hasInput ? 11 : 9, boundedScreenHeight);

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

function formatInputValue(value: string, placeholder: string): string {
  if (!value) {
    return muted(placeholder);
  }

  return `${value}_`;
}

function renderActionButton(
  label: string,
  {
    disabled = false,
    selected = false,
    tone = "info",
  }: {
    disabled?: boolean;
    selected?: boolean;
    tone?: "danger" | "info";
  } = {},
): string {
  if (disabled) {
    return `{black-fg}{#5f667a-bg}  ${label}  {/}`;
  }

  if (selected) {
    const background = tone === "danger" ? UI_THEME.danger : UI_THEME.accent;
    return `{black-fg}{${background}-bg}  ${label}  {/}`;
  }

  const foreground = tone === "danger" ? UI_THEME.danger : UI_THEME.text;
  return `{${foreground}-fg}${label}{/${foreground}-fg}`;
}

function renderInputLine(label: string, value: string): string {
  return `${fg(UI_THEME.tableHeader, `${label}:`)} ${formatInputValue(value, "required")}`;
}

export function openActionModal(options: ActionModalOptions): ActionModalController {
  const {
    cancelLabel = "Cancel",
    confirmLabel = "Confirm",
    initialValue = "",
    inputLabel,
    message,
    onCancel,
    onConfirm,
    screen,
    title,
    validate,
  } = options;
  const hasInput = Boolean(inputLabel);
  let closed = false;
  let errorMessage = "";
  let inputValue = initialValue;
  let selectedButton: ActionButton = "confirm";
  let layout = calculateActionModalLayout(Number(screen.width), Number(screen.height), hasInput);

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
    height: 2,
    left: 2,
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
    top: 4,
    width: Math.max(layout.width - 4, 1),
  });

  const errorBox = blessed.box({
    height: 1,
    left: 2,
    tags: true,
    top: hasInput ? 5 : 4,
    width: Math.max(layout.width - 4, 1),
  });

  const buttonBox = blessed.box({
    align: "center",
    height: 1,
    left: 2,
    tags: true,
    top: hasInput ? 7 : 6,
    width: Math.max(layout.width - 4, 1),
  });

  modalBox.append(messageBox);
  if (hasInput) {
    modalBox.append(inputBox);
  }
  modalBox.append(errorBox);
  modalBox.append(buttonBox);

  const getValidationMessage = () => validate?.(inputValue) ?? null;
  const canConfirm = () => getValidationMessage() === null;

  const updateLayout = () => {
    layout = calculateActionModalLayout(Number(screen.width), Number(screen.height), hasInput);
    backdropBox.setContent(buildBackdropContent(Number(screen.width), Number(screen.height)));
    modalBox.top = layout.top;
    modalBox.left = layout.left;
    modalBox.width = layout.width;
    modalBox.height = layout.height;
    messageBox.width = Math.max(layout.width - 4, 1);
    inputBox.width = Math.max(layout.width - 4, 1);
    errorBox.width = Math.max(layout.width - 4, 1);
    buttonBox.width = Math.max(layout.width - 4, 1);
  };

  const updateContent = () => {
    const confirmEnabled = canConfirm();
    messageBox.setContent(bold(message));
    if (hasInput) {
      inputBox.setContent(renderInputLine(inputLabel ?? "Value", inputValue));
    }
    errorBox.setContent(
      errorMessage
        ? `{${toneTag("error")}}${truncate(errorMessage, Math.max(layout.width - 4, 1)).trimEnd()}{/${toneTag("error")}}`
        : "",
    );
    buttonBox.setContent([
      renderActionButton(cancelLabel, { selected: selectedButton === "cancel", tone: "danger" }),
      renderActionButton(confirmLabel, { disabled: !confirmEnabled, selected: selectedButton === "confirm" }),
    ].join("      "));
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

    if (key.name === "escape") {
      cancel();
      return true;
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
