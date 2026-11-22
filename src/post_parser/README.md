# Post Parser

## Overview

The post parser analyzes social media posts in three stages:

1. **Image Text Extraction:** All images associated with a post are analyzed using PaddleOCR to extract text.

2. **Initial Post Classification:** The extracted image text and post caption are analyzed by Jev AI to determine whether the post contains an announcement about a free event or item.

3. **Structured Data Extraction:** If the post contains free goodies, the Kimi-K3 model analyzes the extracted image text and caption again, parsing the information and exporting it as a JSON object.

## Configuration

Before running the parser, make sure to set the following API keys as environment variables:

    MOONSHOT_API_KEY=your_moonshot_api_key
    TYPESAFE_API_KEY=your_typesafe_api_key
    PADDLEOCR_API_KEY=your_paddleocr_api_key

## Usage

To use the parser, instantiate `PostParser` and call `PostParser.evaluate_post()`.

The function accepts a dictionary/JSON object containing the following fields:

| Field | Description |
|---|---|
| `timestamp` | Date of post publication |
| `thumbnail_url` | URL of the post's thumbnail image |
| `caption` | Caption text associated with the post |
| `media_type` | Type of the post |
| `children` | Subsections of the post (e.g. if there are multiple images) |

These fields are all natively included in the output of `scrapper.py`.

### Return Value

`PostParser.evaluate_post()` returns a JSON string with the following structure:
```json
    {
        "is_deal": "bool",
        "title": "string",
        "description": "string",
        "date": "string|null",
        "start_time": "string|null",
        "end_time": "string|null",
        "offer_type": "free_item|discount|raffle|other",
        "offer_category": "food|service|clothing|merch|event|other",
        "location": "string|null",
        "address_line_1": "string|null",
        "address_line_2": "string|null",
        "conditions": "string|null"
    }
```

## Model Configuration

The `PostParser` instance accepts several optional arguments to configure the AI models used during processing.

### Model Selection

| Argument | Default Value | Description |
|---|---|---|
| `jev_model` | `"jev-latest"` | Model used for initial post classification. |
| `kimi_model` | `"kimi-k3"` | Model used for structured data extraction. |
| `paddle_model` | `"PP-OCRv6"` | Model used for image text extraction. |

These arguments allow you to specify which models are used by the different AI services.

Please consult the respective model documentation to ensure that you provide an appropriately formatted model identifier.

### Kimi Reasoning Effort

The `kimi_reasoning_effort` argument controls the reasoning effort used by the Kimi model.

**Default value:**

    kimi_reasoning_effort="high"

**Available options:**

- `"low"`
- `"high"`
- `"max"`

### Max Children
For 'carousel-album'-type posts, the `max_children` argument sets the maxium number of images that will be analyzed. This is to avoid the parser spending too long on long posts that contain many images.
