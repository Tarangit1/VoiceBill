from contextlib import asynccontextmanager
from datetime import datetime, timezone
from io import BytesIO
import json
import logging
import os
from pathlib import Path
import re
import sqlite3
from urllib.parse import urlencode
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi import File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
import qrcode
from dotenv import load_dotenv
import httpx

DATABASE_PATH = Path(__file__).parent / "voicebill.db"
logger = logging.getLogger("voicebill")
load_dotenv(Path(__file__).parent / ".env")
MERCHANT_UPI_ID = os.getenv("VOICEBILL_UPI_ID", "8168815168@yespop")
MERCHANT_NAME = os.getenv("VOICEBILL_MERCHANT_NAME", "Myshop")
NVIDIA_NIM_BASE_URL = "https://integrate.api.nvidia.com/v1"
NVIDIA_NIM_MODEL = os.getenv("NVIDIA_NIM_MODEL", "nvidia/nemotron-3.5-lightning-30b-a3b")
SARVAM_STT_URL = "https://api.sarvam.ai/speech-to-text"

BILLING_ASSISTANT_INSTRUCTIONS = """You are the concise, friendly billing assistant for Myshop.
The customer speaks in English or Hinglish. Reply in the same style as the customer.
Confirm an item only when the supplied bill update says one was saved. Do not invent items, prices, or totals.
After a normal turn, end with a short invitation such as 'What would you like to add next?'
If there was no saved item, politely ask for the item, quantity, and price.
Keep replies to two short sentences or fewer."""

NUMBER_WORDS = {
    "ek": 1, "one": 1, "do": 2, "two": 2, "teen": 3, "three": 3,
    "char": 4, "four": 4, "paanch": 5, "five": 5, "che": 6, "six": 6,
    "saat": 7, "seven": 7, "aath": 8, "eight": 8, "nau": 9, "nine": 9,
    "das": 10, "ten": 10, "bees": 20, "twenty": 20, "pachas": 50,
    "fifty": 50, "sau": 100, "hundred": 100,
}
CURRENCY_WORDS = {"rupee", "rupees", "rupay", "rupaye", "rs", "inr"}
FILLER_WORDS = {"add", "ka", "ki", "ke", "for", "at", "price", "please", "item"}


def get_connection() -> sqlite3.Connection:
    connection = sqlite3.connect(DATABASE_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def initialize_database() -> None:
    with get_connection() as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS billing_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                status TEXT NOT NULL DEFAULT 'open',
                created_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS bill_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                quantity REAL NOT NULL,
                unit_price REAL NOT NULL,
                source_transcript TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY (session_id) REFERENCES billing_sessions(id)
            )
            """
        )


@asynccontextmanager
async def lifespan(_: FastAPI):
    initialize_database()
    yield


app = FastAPI(title="VoiceBill API", version="0.2.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_origin_regex=r"https?://(localhost|127\.0\.0\.1):\d+",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class BillingSession(BaseModel):
    id: int
    status: str
    created_at: str


class BillItem(BaseModel):
    id: int
    session_id: int
    name: str
    quantity: float
    unit_price: float
    line_total: float
    source_transcript: str | None = None
    created_at: str


class BillSummary(BillingSession):
    items: list[BillItem]
    total: float


class Invoice(BillSummary):
    merchant_name: str
    upi_id: str
    upi_payment_url: str


class BillingHistoryItem(BillingSession):
    item_count: int
    total: float


class TranscriptRequest(BaseModel):
    transcript: str = Field(min_length=2, max_length=300)


class CreateItemRequest(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    quantity: float = Field(gt=0, le=10_000)
    unit_price: float = Field(ge=0, le=1_000_000)


class UpdateItemRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    quantity: float | None = Field(default=None, gt=0, le=10_000)
    unit_price: float | None = Field(default=None, ge=0, le=1_000_000)


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=300)


class ChatResponse(BaseModel):
    assistant_message: str
    added_item: BillItem | None = None
    added_items: list[BillItem] = Field(default_factory=list)
    should_finalize: bool = False


class LlmBillItem(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    quantity: float = Field(gt=0, le=10_000)
    unit_price: float = Field(ge=0, le=1_000_000)


class BillingDecision(BaseModel):
    intent: Literal["add_items", "finish", "clarify"]
    items: list[LlmBillItem] = Field(default_factory=list)
    reply: str = Field(min_length=1, max_length=300)


class TranscriptResponse(BaseModel):
    transcript: str
    language_code: str | None = None


def session_or_404(connection: sqlite3.Connection, session_id: int) -> sqlite3.Row:
    session = connection.execute("SELECT * FROM billing_sessions WHERE id = ?", (session_id,)).fetchone()
    if not session:
        raise HTTPException(status_code=404, detail="Billing session not found.")
    return session


def row_to_item(row: sqlite3.Row) -> BillItem:
    return BillItem(
        id=row["id"], session_id=row["session_id"], name=row["name"],
        quantity=row["quantity"], unit_price=row["unit_price"],
        line_total=round(row["quantity"] * row["unit_price"], 2),
        source_transcript=row["source_transcript"], created_at=row["created_at"],
    )


def parse_spoken_item(transcript: str) -> tuple[str, float, float]:
    """Parse simple phrases: 'ek chai das rupaye' or '2 coffees 50 rupees'."""
    normalized = transcript.lower().replace("₹", " rs ")
    normalized = re.sub(r"[^a-z0-9.\s-]", " ", normalized)
    tokens = [token for token in re.split(r"\s+", normalized) if token]
    numbers: list[tuple[int, float]] = []

    for index, token in enumerate(tokens):
        if re.fullmatch(r"\d+(?:\.\d+)?", token):
            numbers.append((index, float(token)))
        elif token in NUMBER_WORDS:
            numbers.append((index, float(NUMBER_WORDS[token])))

    if not numbers:
        raise ValueError("Include a quantity and price, for example: 'ek chai das rupaye'.")

    has_currency = any(token in CURRENCY_WORDS for token in tokens)
    if len(numbers) == 1:
        if not has_currency:
            raise ValueError("Include a price, for example: 'ek chai das rupaye'.")
        quantity, price = 1.0, numbers[0][1]
        number_indexes = {numbers[0][0]}
    else:
        quantity, price = numbers[0][1], numbers[-1][1]
        number_indexes = {numbers[0][0], numbers[-1][0]}

    blocked = CURRENCY_WORDS | FILLER_WORDS
    name_tokens = [
        token for index, token in enumerate(tokens)
        if index not in number_indexes and token not in blocked and token != "rs"
    ]
    name = " ".join(name_tokens).strip("- ")
    if not name:
        raise ValueError("I could not find an item name in that phrase.")
    return name.title(), quantity, price


def split_spoken_items(message: str) -> list[str]:
    number_prefix = r"(?:\d+(?:\.\d+)?|ek|one|do|two|teen|three|char|four|paanch|five|che|six|saat|seven|aath|eight|nau|nine|das|ten|bees|twenty|pachas|fifty|sau|hundred)"
    separated = re.sub(
        rf"\b(rupees?|rupay|rupaye|rs|inr)\b\s*(?:,|\band\b|\baur\b)?\s*(?=(?:add\s+)?{number_prefix}\b)",
        r"\1. ",
        message,
        flags=re.IGNORECASE,
    )
    return [phrase.strip(" ,") for phrase in re.split(r"\s*(?:[.!?;]+|\bthen\b|\band then\b)\s*", separated) if phrase.strip(" ,")]


def insert_item(connection: sqlite3.Connection, session_id: int, name: str, quantity: float, unit_price: float, transcript: str | None) -> BillItem:
    created_at = datetime.now(timezone.utc).isoformat()
    cursor = connection.execute(
        """INSERT INTO bill_items (session_id, name, quantity, unit_price, source_transcript, created_at)
        VALUES (?, ?, ?, ?, ?, ?)""",
        (session_id, name, quantity, unit_price, transcript, created_at),
    )
    return BillItem(
        id=cursor.lastrowid, session_id=session_id, name=name, quantity=quantity,
        unit_price=unit_price, line_total=round(quantity * unit_price, 2),
        source_transcript=transcript, created_at=created_at,
    )


def get_invoice(session_id: int) -> Invoice:
    with get_connection() as connection:
        session = session_or_404(connection, session_id)
        items = [row_to_item(row) for row in connection.execute(
            "SELECT * FROM bill_items WHERE session_id = ? ORDER BY id", (session_id,)
        )]
    total = round(sum(item.line_total for item in items), 2)
    payment_parameters = urlencode({
        "pa": MERCHANT_UPI_ID,
        "pn": MERCHANT_NAME,
        "am": f"{total:.2f}",
        "cu": "INR",
        "tn": f"Invoice {session_id}",
    })
    return Invoice(
        **dict(session), items=items, total=total, merchant_name=MERCHANT_NAME,
        upi_id=MERCHANT_UPI_ID, upi_payment_url=f"upi://pay?{payment_parameters}",
    )


def interpret_billing_message(message: str) -> BillingDecision:
    """Ask Nemotron to identify intent and all complete billing items in one turn."""
    api_key = os.getenv("NVIDIA_NIM_API_KEY")
    if not api_key:
        return BillingDecision(intent="clarify", reply="The billing assistant is not configured.")
    instructions = """You extract billing actions for an Indian shop from English or Hinglish speech.
Return ONLY valid JSON with this exact shape:
{"intent":"add_items|finish|clarify","items":[{"name":"string","quantity":number,"unit_price":number}],"reply":"short friendly reply"}
Rules: Understand multiple items, shared prices (for example 'one Kurkure and one Lays, both 10 rupees'), and conversational Hindi-English.
Use intent finish for 'that's all', 'bas ho gaya', 'finish bill', or equivalent; items must then be [].
Use clarify if the item, quantity, or price is missing. Never guess missing prices. For add_items, include every requested item and only explicit quantities/prices.
Keep the reply short and end normal replies by asking what to add next."""
    try:
        from openai import OpenAI

        response = OpenAI(base_url=NVIDIA_NIM_BASE_URL, api_key=api_key).chat.completions.create(
            model=NVIDIA_NIM_MODEL,
            messages=[
                {"role": "system", "content": instructions},
                {"role": "user", "content": message},
            ],
            temperature=0,
            max_tokens=300,
            # Nemotron 3.5 Lightning thinks by default. For a short structured
            # extraction response, turn that mode off so tokens go to the JSON.
            extra_body={"chat_template_kwargs": {"enable_thinking": False}},
        )
        content = (response.choices[0].message.content or "").strip()
        start, end = content.find("{"), content.rfind("}")
        if start < 0 or end < start:
            raise ValueError("No JSON object in model response")
        return BillingDecision.model_validate(json.loads(content[start:end + 1]))
    except Exception as error:
        import traceback
        traceback.print_exc()
        logger.warning("Nemotron billing interpretation failed: %s", error)
        print(f"[DEBUG] interpret_billing_message FAILED: {type(error).__name__}: {error}", flush=True)
        return BillingDecision(intent="clarify", reply="I did not catch that. Please say the item, quantity, and price.")


@app.post("/transcribe", response_model=TranscriptResponse)
async def transcribe_audio(file: UploadFile = File(...)) -> TranscriptResponse:
    api_key = os.getenv("SARVAM_API_KEY")
    if not api_key:
        raise HTTPException(status_code=503, detail="Sarvam speech transcription is not configured.")
    audio = await file.read()
    if not audio:
        raise HTTPException(status_code=400, detail="The recorded audio was empty.")
    content_type = (file.content_type or "audio/webm").split(";", 1)[0]
    try:
        async with httpx.AsyncClient(timeout=45) as client:
            response = await client.post(
                SARVAM_STT_URL,
                headers={"api-subscription-key": api_key},
                files={"file": (file.filename or "speech.webm", audio, content_type)},
                data={
                    "model": "saaras:v3",
                    "mode": "translit",
                    "language_code": "unknown",
                },
            )
        if response.is_error:
            logger.warning("Sarvam transcription failed: %s %s", response.status_code, response.text[:300])
            raise HTTPException(status_code=502, detail="Speech transcription could not be completed.")
        result = response.json()
        return TranscriptResponse(
            transcript=result.get("transcript", "").strip(),
            language_code=result.get("language_code"),
        )
    except httpx.HTTPError as error:
        logger.warning("Sarvam transcription request failed: %s", error)
        raise HTTPException(status_code=502, detail="Speech transcription service is unavailable.") from error
@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/sessions", response_model=BillingSession, status_code=201)
def create_billing_session() -> BillingSession:
    created_at = datetime.now(timezone.utc).isoformat()
    with get_connection() as connection:
        cursor = connection.execute(
            "INSERT INTO billing_sessions (status, created_at) VALUES (?, ?)", ("open", created_at)
        )
    return BillingSession(id=cursor.lastrowid, status="open", created_at=created_at)


@app.get("/sessions/{session_id}", response_model=BillSummary)
def get_billing_session(session_id: int) -> BillSummary:
    with get_connection() as connection:
        session = session_or_404(connection, session_id)
        items = [row_to_item(row) for row in connection.execute(
            "SELECT * FROM bill_items WHERE session_id = ? ORDER BY id", (session_id,)
        )]
    return BillSummary(**dict(session), items=items, total=round(sum(item.line_total for item in items), 2))


@app.get("/sessions", response_model=list[BillingHistoryItem])
def list_billing_sessions(limit: int = 20) -> list[BillingHistoryItem]:
    safe_limit = min(max(limit, 1), 100)
    with get_connection() as connection:
        rows = connection.execute(
            """
            SELECT sessions.id, sessions.status, sessions.created_at,
                   COUNT(items.id) AS item_count,
                   COALESCE(SUM(items.quantity * items.unit_price), 0) AS total
            FROM billing_sessions AS sessions
            LEFT JOIN bill_items AS items ON items.session_id = sessions.id
            GROUP BY sessions.id
            ORDER BY sessions.id DESC
            LIMIT ?
            """,
            (safe_limit,),
        ).fetchall()
    return [BillingHistoryItem(**dict(row)) for row in rows]


@app.get("/sessions/{session_id}/invoice", response_model=Invoice)
def get_session_invoice(session_id: int) -> Invoice:
    return get_invoice(session_id)


@app.get("/sessions/{session_id}/invoice/qr")
def get_session_invoice_qr(session_id: int) -> StreamingResponse:
    invoice = get_invoice(session_id)
    image = qrcode.make(invoice.upi_payment_url)
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    buffer.seek(0)
    return StreamingResponse(buffer, media_type="image/png")


@app.post("/sessions/{session_id}/items", response_model=BillItem, status_code=201)
def create_bill_item(session_id: int, item: CreateItemRequest) -> BillItem:
    with get_connection() as connection:
        session_or_404(connection, session_id)
        return insert_item(connection, session_id, item.name.strip(), item.quantity, item.unit_price, None)


@app.delete("/sessions/{session_id}/items/{item_id}", status_code=204)
def delete_bill_item(session_id: int, item_id: int) -> None:
    with get_connection() as connection:
        session_or_404(connection, session_id)
        cursor = connection.execute(
            "DELETE FROM bill_items WHERE id = ? AND session_id = ?", (item_id, session_id)
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Bill item not found.")


@app.patch("/sessions/{session_id}/items/{item_id}", response_model=BillItem)
def update_bill_item(session_id: int, item_id: int, update: UpdateItemRequest) -> BillItem:
    changes = update.model_dump(exclude_unset=True)
    if not changes:
        raise HTTPException(status_code=400, detail="Provide at least one item field to update.")
    with get_connection() as connection:
        session_or_404(connection, session_id)
        current = connection.execute(
            "SELECT * FROM bill_items WHERE id = ? AND session_id = ?", (item_id, session_id)
        ).fetchone()
        if not current:
            raise HTTPException(status_code=404, detail="Bill item not found.")
        name = changes.get("name", current["name"]).strip()
        quantity = changes.get("quantity", current["quantity"])
        unit_price = changes.get("unit_price", current["unit_price"])
        connection.execute(
            "UPDATE bill_items SET name = ?, quantity = ?, unit_price = ? WHERE id = ?",
            (name, quantity, unit_price, item_id),
        )
        updated = connection.execute("SELECT * FROM bill_items WHERE id = ?", (item_id,)).fetchone()
    return row_to_item(updated)


@app.post("/sessions/{session_id}/items/from-transcript", response_model=BillItem, status_code=201)
def create_item_from_transcript(session_id: int, request: TranscriptRequest) -> BillItem:
    try:
        name, quantity, price = parse_spoken_item(request.transcript)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    with get_connection() as connection:
        session_or_404(connection, session_id)
        return insert_item(connection, session_id, name, quantity, price, request.transcript)


@app.post("/sessions/{session_id}/chat", response_model=ChatResponse)
def chat_about_bill(session_id: int, request: ChatRequest) -> ChatResponse:
    decision = interpret_billing_message(request.message)
    with get_connection() as connection:
        session_or_404(connection, session_id)
        items: list[BillItem] = []
        if decision.intent == "add_items":
            for item in decision.items:
                items.append(insert_item(
                    connection, session_id, item.name.strip(), item.quantity, item.unit_price, request.message
                ))
    return ChatResponse(
        assistant_message="Generating your bill." if decision.intent == "finish" else decision.reply,
        added_item=items[0] if items else None,
        added_items=items,
        should_finalize=decision.intent == "finish",
    )
