import json


BUTTON_START = "Start"
BUTTON_FINISH = "Finish"
BUTTON_CANCEL = "Cancel"
BUTTON_MODE_SEARCH = "Search"
BUTTON_MODE_USER_IMAGES = "User Images"
BUTTON_SCOPE_SKIP_PROCESSED = "Skip Processed"
BUTTON_SCOPE_SCAN_ALL = "Scan All"

COMMAND_START = "start"
COMMAND_FINISH = "finish"

SCAN_MODE_QUERY = "query"
SCAN_MODE_USER_IMAGES = "user_images"

TEXT_CHOOSE_ACTION = "Choose an action."
TEXT_CHOOSE_MODE = "Choose an action."
TEXT_CHOOSE_SCOPE = "Choose how to handle previously processed images."
TEXT_ACCESS_DENIED = "Access denied."
TEXT_NO_ACTIVE_SCAN = "There is no active scan."
TEXT_SEND_QUERY = "Send the Docker Hub search query."
TEXT_SEND_USER_IMAGES = "Send the Docker Hub user or namespace."
TEXT_USE_START = "Use Start to launch a scan."
TEXT_START_CANCELLED = "Start cancelled."


def reply_keyboard(*rows: list[str]) -> str:
    keyboard = {
        "keyboard": [[{"text": button} for button in row] for row in rows],
        "resize_keyboard": True,
        "one_time_keyboard": False,
        "is_persistent": True,
    }
    return json.dumps(keyboard, ensure_ascii=False)


def idle_keyboard() -> str:
    return reply_keyboard([BUTTON_START])


def awaiting_query_keyboard() -> str:
    return reply_keyboard([BUTTON_CANCEL])


def mode_keyboard() -> str:
    return reply_keyboard([BUTTON_MODE_SEARCH, BUTTON_MODE_USER_IMAGES], [BUTTON_CANCEL])


def scope_keyboard() -> str:
    return reply_keyboard([BUTTON_SCOPE_SKIP_PROCESSED, BUTTON_SCOPE_SCAN_ALL], [BUTTON_CANCEL])


def running_keyboard() -> str:
    return reply_keyboard([BUTTON_FINISH])


def command_definitions() -> list[dict[str, str]]:
    return [
        {"command": COMMAND_START, "description": "Show control buttons"},
        {"command": COMMAND_FINISH, "description": "Stop the active scan"},
    ]


def describe_scan_target(target: str, mode: str = SCAN_MODE_QUERY) -> str:
    if mode == SCAN_MODE_USER_IMAGES:
        return f"user images '{target}'"
    return f"search '{target}'"


def started_scan_text(target: str, mode: str = SCAN_MODE_QUERY) -> str:
    return f"Started scan for {describe_scan_target(target, mode)}."


def stopping_scan_text(target: str, mode: str = SCAN_MODE_QUERY) -> str:
    return f"Stopping scan for {describe_scan_target(target, mode)}."


def already_running_text(target: str, mode: str = SCAN_MODE_QUERY) -> str:
    return f"Scan for {describe_scan_target(target, mode)} is already running."


def stopped_scan_text(target: str, mode: str = SCAN_MODE_QUERY) -> str:
    return f"Scan for {describe_scan_target(target, mode)} stopped."


def failed_scan_text(target: str, mode: str = SCAN_MODE_QUERY) -> str:
    return f"Scan for {describe_scan_target(target, mode)} failed."


def finished_scan_text(target: str, processed: int, matches: int, mode: str = SCAN_MODE_QUERY) -> str:
    return (
        f"Scan for {describe_scan_target(target, mode)} finished. "
        f"Processed {processed} images, found matches in {matches}."
    )
