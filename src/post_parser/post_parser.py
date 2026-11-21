from openai import OpenAI

class PostParser:

    KIMI_SYSTEM = """You are tasked with getting information from web posts. Each post
    contains information about a deal or an offer that a business or organization
    is giving. Your task is to extract relevant information and output it as a JSON
    object matching the schema. Do not guess, if information is missing or unclear,
    leave fields as null. If the date is not explicit, you may calculate it using 
    the date of the post or leave it as null. Provide a title and a short description.
    list any conditions(eg. student-id, 30 first clients).
    
    SCHEMA:
    {{
    "title": string,
    "description":,
    "date": string|null,
    "start_time": sting|null,
    "end_time": string|null,
    "offer_type": "free_item|discount|raffle|other",
    "offer_category": "food|service|clothing|merch|event|other",
    "location": string|null,
    "address_line_1": string|null,
    "address_line_2": string|null,
    "conditions": string|null,
    }}
    """

    def __init__(self, moonshot_key:str) -> None:
        self.MoonshotClient = OpenAI(
            api_key=moonshot_key, 
            base_url="https://api.moonshot.ai/v1")

    def parse_text(self, content: str) -> str:
        parsed = self.MoonshotClient.chat.completions.create(
            model="kimi-k3",
            reasoning_effort="high",
            messages=[{"role": "system", "content": self.KIMI_SYSTEM}, 
                      {"role": "user", "content": content}]
                      )
        return parsed.choices[0].message.content
