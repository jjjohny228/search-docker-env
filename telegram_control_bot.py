import json


BUTTON_START = "Start"
BUTTON_FINISH = "Finish"
BUTTON_CANCEL = "Cancel"

COMMAND_START = "start"
COMMAND_FINISH = "finish"

TEXT_CHOOSE_ACTION = "Choose an action."
TEXT_ACCESS_DENIED = "Access denied."
TEXT_NO_ACTIVE_SCAN = "There is no active scan."
TEXT_SEND_QUERY = "Send the Docker Hub search query."
TEXT_USE_START = "Use Start to launch a scan."
TEXT_START_CANCELLED = "Start cancelled."


def reply_keyboard(*rows: list[str]) -> str:
    keyboard = {
        "keyboard": [[{"text": button} for button in row] for row in rows],
        "resize_keyboard": True,
        "one_time_keyboard": False,
    }
    return json.dumps(keyboard, ensure_ascii=False)


def idle_keyboard() -> str:
    return reply_keyboard([BUTTON_START])


def awaiting_query_keyboard() -> str:
    return reply_keyboard([BUTTON_CANCEL])


def running_keyboard() -> str:
    return reply_keyboard([BUTTON_FINISH])


def command_definitions() -> list[dict[str, str]]:
    return [
        {"command": COMMAND_START, "description": "Show control buttons"},
        {"command": COMMAND_FINISH, "description": "Stop the active scan"},
    ]


def started_scan_text(query: str) -> str:
    return f"Started scan for '{query}'."


def stopping_scan_text(query: str) -> str:
    return f"Stopping scan for '{query}'."


def already_running_text(query: str) -> str:
    return f"Scan for '{query}' is already running."


def stopped_scan_text(query: str) -> str:
    return f"Scan for '{query}' stopped."


def failed_scan_text(query: str) -> str:
    return f"Scan for '{query}' failed."


def finished_scan_text(query: str, processed: int, matches: int) -> str:
    return f"Scan for '{query}' finished. Processed {processed} images, found matches in {matches}."
