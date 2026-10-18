"""Prints an n8n credentials import file built from environment variables.

The IDs are fixed so the workflow JSON files can reference them directly.
"""
import json
import os

credentials = [
    {
        "id": "CredTelegram0001",
        "name": "Telegram bot",
        "type": "telegramApi",
        "data": {"accessToken": os.environ["TELEGRAM_BOT_TOKEN"]},
    },
    {
        "id": "CredGhModels0001",
        "name": "GitHub Models (gpt-4o)",
        "type": "openAiApi",
        "data": {
            "apiKey": os.environ["GITHUB_MODELS_TOKEN"],
            "url": "https://models.github.ai/inference",
        },
    },
    {
        "id": "CredGitPush00001",
        "name": "GitHub push token",
        "type": "httpHeaderAuth",
        "data": {"name": "X-Git-Token", "value": os.environ["GITHUB_PUSH_TOKEN"]},
    },
]

print(json.dumps(credentials, indent=2))
