# quiz_tool — screenshot → structured quiz Q&A (Claude)

Extracts multiple-choice questions from screenshots of an online quiz and,
optionally, answers them. Two-stage pipeline to keep costs low:

1. **EXTRACT** — vision model (`claude-haiku-5-5` by default) receives the
   image plus verbatim-copy instructions and returns structured JSON via
   `client.messages.parse(..., output_format=ExtractedQuestion)` (Pydantic):
   `question_number`, `question_type` (`single_choice | multiple_choice_multi_select | true_false | other`),
   `question`, `options[{label,text}]`. UI noise (Save/Note/Submit buttons,
   progress bars, timers) is stripped; "select all that apply" becomes
   multi-select.
2. **ANSWER** — text-only model (`claude-sonnet-5-5`) receives *only* the
   extracted question text + options (no image → token savings) and returns
   `{correct_labels[], explanation, confidence(high|medium|low)}`.

## Setup (Windows / macOS)

```bash
cd quiz-tool
python -m venv .venv && .venv\Scripts\activate      # Windows
# python3 -m venv .venv && source .venv/bin/activate  # macOS/Linux
pip install -r requirements.txt
echo ANTHROPIC_API_KEY=sk-ant... > .env              # never hard-code the key
```

## Usage

```bash
# One screenshot, extraction only
python quiz_tool.py screen1.png

# Whole folder + answers, custom output paths/models, trim UI margins
python quiz_tool.py ./screens --answer --out results.json \
    --extract-model claude-haiku-5-5 --answer-model claude-sonnet-5-5 \
    --crop 0,80,0,120
```

Outputs: `results.json` (one record per file: `file`, `sha256`, `extraction`,
`answer` or `error`) and `results.csv`
(`file, question, A, B, C, D, answer, confidence`).

## Behaviour & robustness

- API key read from `ANTHROPIC_API_KEY` (supports `.env` via python-dotenv).
- Images pre-processed with Pillow: RGB, long edge ≤ 1568 px, base64 PNG.
- Exponential backoff on 429 / 5xx / overloaded errors (max 3 retries);
  `stop_reason == "max_tokens"` retries once with doubled budget;
  `"refusal"` is logged and skipped; one bad file never aborts the batch.
- Token usage logged per call; estimated total cost printed at the end using
  `PRICES_PER_MTOK` (haiku-5-5 $0.10/$0.50, sonnet-5-5 $2/$10, opus-5-5 $4/$20
  per million tokens in/out).
- Results cached by SHA-256 of the original image bytes (`.quiz_cache.json`),
  so re-running does not re-bill the same screenshot (`--no-cache` disables).

## Test

```bash
python -m pytest test_quiz_tool.py        # offline: schemas, preprocessing, CSV, CLI wiring
# Live smoke test (needs a key + sample images in samples/):
python quiz_tool.py samples --answer --out samples/results.json
```
