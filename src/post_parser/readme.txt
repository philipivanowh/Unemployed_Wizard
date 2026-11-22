Before running, be sure to set your API keys as environment variables:
MOONSHOT_API_KEY
TYPESAFE_API_KEY
PADDLEOCR_API_KEY

To run, instantiate PostParser and call PostParser.evaluate_post. This function takes a dict/json object with the following fields: 'timestamp', 'thumbnail_url', and 'caption'. These are all natively included in the output of scrapper.py.

PostParser.evaluate_post will return a json string of the form:
          {
            "is_deal": "bool",
            "title": "string",
            "description":,
            "date": "string|null",
            "start_time": "string|null",
            "end_time": "string|null",
            "offer_type": "free_item|discount|raffle|other",
            "offer_category": "food|service|clothing|merch|event|other",
            "location": "string|null",
            "address_line_1": "string|null",
            "address_line_2": "string|null",
            "conditions": "string|null",
          }

The PostParser instace can take a few arguments:
	jev_model:str = "jev-latest"
	kimi_model:str = "kimi-k3"
	paddel_model:str = "PP-OCRv6"
    These three arguments set the models of the different AIs. Please consult the respective 
    model's documentation to provide an appropriately formatted model identifier.
	
	kimi_reasoning_effor:str = "high"
    Possible options: {"low", "high", "max"}
