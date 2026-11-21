import os

import cv2
import numpy as np
import requests
from openai import OpenAI
from paddleocr import PaddleOCR
from typesafe_sdk import Noul, TypeSafeClient


class PostParser:
    def __init__(self) -> None:
        # Descritption of the Jev task
        self.JEV_TICKET = """We are trying to identify whether this post contains an advertisement
            for free or discounted items/events, or raffles and giveaways. We have pulled together
            a JSON object that contains all the information in the post."""
        # Questions to be asked to Jec. Separated questions to avoid overstimulating the poor dude
        self.QUESTIONS = {
            "offers_free": Noul(
                instructions="Do the caption or image offer anything at no cost to the customer?"
            ),
            "offers_discount": Noul(
                instructions="Do the caption or image offer any discount or deal for buyers?"
            ),
            "offers_raffle": Noul(
                instructions="Do the caption or image offer any free items as a result of a competion or raffle?"
            ),
        }
        # Context for Kimi K3
        self.KIMI_SYSTEM = """You are tasked with getting information from web posts. Each post
            contains information about a deal or an offer that a business or organization
            is giving. Your task is to extract relevant information and output it as a JSON
            object matching the schema. Do not guess, if information is missing or unclear,
            leave fields as null. If the date is not explicit, you may calculate it using 
            the date of the post or leave it as null. Provide a title and a short description.
            list any conditions(eg. student-id, 30 first clients). Make sure to mark every object
            as a deal.
            
            SCHEMA:
            {
            "is_deal": True,
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
            }
            """

        # Initialize the Jev and Kimi K3 clients.
        self.JevClient = TypeSafeClient(
            model="jev-latest"
        )  # Requires API key in TYPESAFE_API_KEY
        self.MoonshotClient = OpenAI(
            api_key=os.environ["MOONSHOT_API_KEY"],
            base_url="https://api.moonshot.ai/v1",
        )

        # Initialize the PaddleOCR instance.
        self.ocr = PaddleOCR(
            use_doc_orientation_classify=False,  # Disables document orientation classification model via this parameter
            use_doc_unwarping=False,  # Disables text image rectification model via this parameter
            use_textline_orientation=False,  # Disables text line orientation classification model via this parameter
            device="cpu",
            enable_mkldnn=False,
        )

    def __parse_image(self, url: str, min_score: float = 0.5) -> str:
        """Gets the text on an image from its URL using PaddleOCR."""
        # Check if url is empty:
        if not url:
            print("No image in post")
            return None

        # Fetch image from URL.
        resp = requests.get(url=url, timeout=15)
        resp.raise_for_status()

        # Convert image.
        buffer = np.frombuffer(resp.content, dtype=np.uint8)
        image = cv2.imdecode(buffer, cv2.IMREAD_COLOR)

        # Loop over all lines of text in the image
        lines = []
        for res in self.ocr.predict(image):
            for text, score in zip(res["rec_texts"], res["rec_scores"]):
                if score >= min_score:  # Exclude lines with low certainty score.
                    lines.append(text)

        return " ".join(lines)

    def __parse_text(self, content: str) -> str:
        """Parses post information to produce JSON with the relevant information."""
        # Get response from Kimi API.
        parsed = self.MoonshotClient.chat.completions.create(
            model="kimi-k3",
            reasoning_effort="high",
            messages=[
                {"role": "system", "content": self.KIMI_SYSTEM},
                {"role": "user", "content": content},
            ],
        )
        return parsed.choices[0].message.content

    def __evaluate_content(self, content: str, min_score: float = 0.7) -> bool:
        """Evalutes the contents of a post to determine if they contain free goodies."""

        # Get response from Jev API.
        response = self.JevClient.system_one(
            state={"ticket": self.JEV_TICKET, "content": content},
            questions=self.QUESTIONS,
        )
        return (  # Joining the answers to all Jev questions.
            response.nouls["offers_free"].noul >= min_score
            or response.nouls["offers_discount"].noul >= min_score
            or response.nouls["offers_raffle"].noul >= min_score
        )

    def evaluate_post(self, post_info: dict) -> str:
        """
        Evaluates a post and returns the JSON with its contents.
            Arguments:
                post_info: dict
                    A dictionary containing the following fields:
                        "timestamp", "thumbnail_url", "caption"
        """
        # Assemble necessary context.
        image = self.__parse_image(post_info["thumbnail_url"])
        parsing_content = {
            "timestamp": post_info["timestamp"],
            "image_text": image,
            "caption": post_info["caption"],
        }

        # Use Jev to see if there are any goodies.
        if self.__evaluate_content(str(parsing_content)):
            description = self.__parse_text(str(parsing_content))
        else:
            description = """
            {
            "is_deal": false,
            "title": null,
            "description": null,
            "date": null,
            "start_time": null,
            "end_time": null,
            "offer_type": null,
            "offer_category": null,
            "location": null,
            "address_line_1": null,
            "address_line_2": null,
            "conditions": null,
            }
            """
        return description
