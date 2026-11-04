# VoiceBill

Minimal billing-dashboard starter with a Vite + React client and FastAPI service.

## Run locally

In one terminal:

```powershell
cd Server
py -m pip install -r requirements.txt
py -m uvicorn main:app --reload
```

In a second terminal:

```powershell
cd Client
npm install
npm run dev
```

Open the Vite URL (normally `http://localhost:5173`). The dashboard checks `GET /health` when it loads and creates SQLite-backed billing sessions with **Start Billing**.

## Billing API

- `POST /sessions` creates a bill.
- `POST /sessions/{session_id}/items/from-transcript` accepts `{ "transcript": "ek chai das rupaye" }` and saves an item.
- `GET /sessions/{session_id}` returns its items and total.
- `GET /sessions/{session_id}/invoice` returns the final invoice and exact-amount UPI payment URL.
- `GET /sessions/{session_id}/invoice/qr` returns the matching UPI QR image.

The transcript parser currently supports simple quantity-and-price phrases such as `ek chai das rupaye` and `2 coffees 50 rupees`. A production speech-to-text provider can later send its clean transcript to the same endpoint.

UPI details are set through `VOICEBILL_UPI_ID` and `VOICEBILL_MERCHANT_NAME` environment variables; the starter is configured for Myshop and `Your_UPI_ID`.

## Conversational billing

`POST /sessions/{session_id}/chat` accepts `{ "message": "ek chai das rupaye" }`, saves a recognised item, and returns a conversational assistant reply. Set `NVIDIA_NIM_API_KEY` before starting the server to use NVIDIA NIM. The server uses NVIDIA's OpenAI-compatible chat-completions endpoint at `https://integrate.api.nvidia.com/v1`; `NVIDIA_NIM_MODEL` defaults to `nvidia/nemotron-3.5-lightning-30b-a3b`.
