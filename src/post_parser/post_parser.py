import io
import json
import os
import time

import cv2
import numpy as np
import requests
from openai import OpenAI
from typesafe_sdk import Noul, TypeSafeClient


class PostParser:
    def __init__(
        self,
        jev_model: str = "jev-latest",
        kimi_model: str = "kimi-k3",
        kimi_reasoning_effort: str = "high",
        paddel_model: str = "PP-OCRv6",
    ) -> None:

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
        self.KIMI_MODEL = kimi_model
        self.KIMI_REASONING_EFFORT = kimi_reasoning_effort
        # Context for Kimi K3
        self.KIMI_SYSTEM = """You are tasked with getting information from web posts. Each post
            contains information about a deal or an offer that a business or organization
            is giving. Your task is to extract relevant information and output it as a JSON
            object matching the schema. You may guess, if information is missing or unclear,
            try to fill out at least the fields title, date, start_time and end_time with relevant 
            information. If information is cannot be infered, leave the values 
            as null. If the date is not explicit, you may calculate it using the date of the post or 
            leave it as null. Provide a title and a short description. Please list any conditions that 
            apply to the deals(eg. student-id, 30 first clients). Make sure to mark every object as a 
            deal since we already know that every post contains a promotion of some sort. Please write 
            dates in "YYYY-MM-DD" format and time in "24:00" format.
            
            SCHEMA:
            {
            "is_deal": "true",
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
            """

        # Initialize the Jev and Kimi K3 clients.
        self.JevClient = TypeSafeClient(
            model=jev_model
        )  # Requires API key in TYPESAFE_API_KEY
        self.MoonshotClient = OpenAI(
            api_key=os.environ["MOONSHOT_API_KEY"],
            base_url="https://api.moonshot.ai/v1",
        )

        # PaddleOCR API parameters:
        self.PADDLE_JOB_URL = "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs"
        self.PADDLE_HEADERS = {
            "Authorization": f"bearer {os.environ['PADDLEOCR_API_KEY']}"
        }

        self.PADDLE_DATA = {
            "model": paddel_model,
            "optionalPayload": json.dumps(
                {
                    "useDocOrientationClassify": False,
                    "useDocUnwarping": False,
                    "useTextlineOrientation": False,
                }
            ),
        }

        self.requests_session = requests.Session()

    def __parse_image(
        self,
        url: str,
        max_attempts: int = 5,
        timeout: float = 120,
        polling_time: float = 2,
    ) -> str:
        """Gets the text on an image from its URL using PaddleOCR."""
        # Check if url is empty:
        if not url:
            print("No image in post")
            return None

        print("Parsing image")

        # Fetch image from URL.
        resp = self.requests_session.get(url=url, timeout=15)
        resp.raise_for_status()

        # PaddleOCR wants a JPEG. Instagram's images usually are one already; convert the rest.
        if resp.content[:3] == b"\xff\xd8\xff":
            jpeg_bytes = resp.content
        else:
            buffer = np.frombuffer(resp.content, dtype=np.uint8)
            image = cv2.imdecode(buffer, cv2.IMREAD_COLOR)
            if image is None:
                raise ValueError("Could not decode the post's image")
            success, encoded_image = cv2.imencode(".jpg", image)
            if not success:
                raise ValueError("Could not encode image to .jpg")
            jpeg_bytes = encoded_image.tobytes()

        # Post job up to max_attempts times.
        print("Posting PaddleOCR job")
        for attempts in range(max_attempts):
            files = {
                "file": ("image.jpg", io.BytesIO(jpeg_bytes), "image/jpeg")
            }
            job_response = self.requests_session.post(
                self.PADDLE_JOB_URL,
                headers=self.PADDLE_HEADERS,
                data=self.PADDLE_DATA,
                files=files,
                timeout=120,
            )

            # Exit loop if job is successfully posted.
            if job_response.status_code == 200:
                break

            # Check if the error is due to API server traffic.
            error_code = job_response.json().get("code")
            if error_code == 10010:
                print(
                    f"Job rejected: PaddleOCR is too busy.\nPolling again in {timeout} seconds.\n{max_attempts - attempts - 1} attemtps remaining."
                )
                time.sleep(60)  # Traffic too high; wait 60 seconds before retrying.
            else:
                raise RuntimeError(
                    f"Unhandled error: {job_response.text}"
                )  # Unexpected error.
        else:
            raise TimeoutError("PaddleOCR too busy. Max calls reached.")

        # Once job is submitted, get id.
        job_id = job_response.json()["data"]["jobId"]
        print("Job submitted successfully; Starting polling.")

        # Poll job until done.
        deadline = time.monotonic() + timeout
        jsonl_url = ""
        while time.monotonic() < deadline:
            # Poll
            job_result_response = self.requests_session.get(
                f"{self.PADDLE_JOB_URL}/{job_id}",
                headers=self.PADDLE_HEADERS,
                timeout=30,
            )
            job_result_response.raise_for_status()

            # Get results from poll,
            result_data = job_result_response.json()["data"]
            state = result_data["state"]

            # Interpred poll results
            if state == "done":
                jsonl_url = result_data["resultUrl"]["jsonUrl"]
                break

            elif state == "failed":
                error_msg = result_data.get("errorMsg")
                raise RuntimeError(f"Job failed; reason: {error_msg}")
            # Job not complete; wait before polling again.
            time.sleep(polling_time)
        else:
            raise TimeoutError(f"Polling not complete after {timeout}s.")
        print("Job done, extracting results.")
        # Download results.
        extracted_text = []
        if jsonl_url:
            # Get response
            jsonl_response = self.requests_session.get(jsonl_url)
            jsonl_response.raise_for_status()

            lines = jsonl_response.text.strip().split("\n")
            extracted_text = []
            for line in lines:
                # Verify that line is not empty.
                if not line.strip():
                    continue

                result = json.loads(line)["result"]

                for res in result["ocrResults"]:
                    texts = res.get("prunedResult", {}).get("rec_texts", [])
                    extracted_text.extend(texts)

        return " ".join(extracted_text)

    def __parse_text(self, content: str, timeout: float = 120) -> str:
        """Parses post information to produce JSON with the relevant information."""
        # Get response from Kimi API.
        print("Kimi AI is parsing the contents of the post.")
        parsed = self.MoonshotClient.chat.completions.create(
            model=self.KIMI_MODEL,
            reasoning_effort=self.KIMI_REASONING_EFFORT,
            messages=[
                {"role": "system", "content": self.KIMI_SYSTEM},
                {"role": "user", "content": content},
            ],
            timeout=timeout,
        )
        return parsed.choices[0].message.content

    def __evaluate_content(
        self, content: str, min_score: float = 0.7, timeout: float = 120
    ) -> bool:
        """Evalutes the contents of a post to determine if they contain free goodies."""

        # Get response from Jev API.
        print("Jev is analyzing the contents of the post.")
        response = self.JevClient.system_one(
            state={"ticket": self.JEV_TICKET, "content": content},
            questions=self.QUESTIONS,
            timeout=timeout,
        )
        return (  # Joining the answers to all Jev questions.
            response.nouls["offers_free"].noul >= min_score
            or response.nouls["offers_discount"].noul >= min_score
            or response.nouls["offers_raffle"].noul >= min_score
        )

    def evaluate_post(self, post_info: dict, max_children:int = 3) -> str:
        """
        Evaluates a post and returns the JSON with its contents.
            Arguments:
                post_info: dict
                    A dictionary containing the following fields:
                        "timestamp", "childrend", "caption"
        """
        # Loop through all the different media in the post.
        image_text = []
        if post_info["media_type"] != "CAROUSEL_ALBUM":
            # Assemble necessary context.
            image = self.__parse_image(post_info["thumbnail_url"])
            image_text.append(image)
        else:
            for child in post_info["children"][:max_children]:
                if child["media_type"] != "VIDEO":
                    # Assemble necessary context.
                    image = self.__parse_image(post_info["media_url"])
                    image_text.append(image)
        # Gather parsing content. 
        parsing_content = {
            "timestamp": post_info["timestamp"],
            "image_text": image_text,
            "caption": post_info["caption"],
        }

        content = json.dumps(parsing_content, ensure_ascii=False)
        # Use Jev to see if there are any goodies.
        if self.__evaluate_content(str(content)):
            return self.__parse_text(str(content))
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
