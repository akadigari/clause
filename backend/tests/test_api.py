"""End-to-end API tests: upload a real PDF, ask, get cited answers back."""

import io

from app.llm import Answer
from tests.conftest import make_pdf

LEASE_PDF_PAGES = [
    [
        "Residential Lease - Test Document",
        "Section 3. Rent. Monthly rent is $2,000 due on the first day of each "
        "month. A late fee of $95 applies if rent is unpaid by the fifth day.",
    ],
    [
        "Section 9. Termination. The tenant may terminate early with sixty "
        "days notice and payment of a termination fee of one month of rent.",
    ],
]


def upload(client, name="test-lease.pdf", pages=LEASE_PDF_PAGES):
    return client.post(
        "/api/documents",
        files={"file": (name, io.BytesIO(make_pdf(pages)), "application/pdf")},
    )


def test_health_reports_llm_and_embedder(client):
    body = client.get("/api/health").json()
    assert body["status"] == "ok"
    assert body["llm"] is True
    assert body["embedder"] == "hash"


def test_upload_parse_and_page_texts(client):
    response = upload(client)
    assert response.status_code == 201
    doc = response.json()
    assert doc["pages"] == 2
    assert doc["chunks"] >= 2
    assert doc["sample"] is False
    assert "late fee of $95" in doc["page_texts"][0]["text"]

    listed = client.get("/api/documents").json()
    assert [d["id"] for d in listed] == [doc["id"]]

    fetched = client.get(f"/api/documents/{doc['id']}").json()
    assert fetched["page_texts"] == doc["page_texts"]


def test_upload_rejects_non_pdf(client):
    response = client.post(
        "/api/documents",
        files={"file": ("notes.txt", io.BytesIO(b"hello"), "text/plain")},
    )
    assert response.status_code == 400

    response = client.post(
        "/api/documents",
        files={"file": ("fake.pdf", io.BytesIO(b"not a pdf at all"), "application/pdf")},
    )
    assert response.status_code == 400


def test_ask_end_to_end_with_receipts(client, fake_answerer):
    doc = upload(client).json()
    fake_answerer.result = Answer(
        found=True,
        answer="Rent is $2,000/month, and the late fee is $95 after the 5th.",
        citations=[0],
    )
    response = client.post(
        "/api/ask", json={"question": "what happens if I pay rent late?"}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["found"] is True
    assert body["mode"] == "llm"

    source = body["sources"][0]
    assert source["doc_id"] == doc["id"]
    page_text = doc["page_texts"][source["page"] - 1]["text"]
    assert page_text[source["start"] : source["end"]] == source["quote"]

    # the LLM saw only chunks, never the whole document
    question, excerpts = fake_answerer.calls[0]
    assert all(len(text) < 3000 for _, text in excerpts)


def test_ask_scoped_to_missing_document_404s(client):
    response = client.post(
        "/api/ask", json={"question": "anything", "doc_ids": ["doc-nope"]}
    )
    assert response.status_code == 404


def test_ask_with_no_documents_abstains(client, fake_answerer):
    response = client.post("/api/ask", json={"question": "what is the rent?"})
    body = response.json()
    assert body["found"] is False
    assert body["mode"] == "abstain"
    assert fake_answerer.calls == []


def test_delete_document(client):
    doc = upload(client).json()
    assert client.delete(f"/api/documents/{doc['id']}").status_code == 204
    assert client.get(f"/api/documents/{doc['id']}").status_code == 404
    assert client.delete(f"/api/documents/{doc['id']}").status_code == 404


def test_keyless_mode_is_extractive_not_hallucinated(keyless_client):
    health = keyless_client.get("/api/health").json()
    assert health["llm"] is False

    upload(keyless_client)
    body = keyless_client.post(
        "/api/ask", json={"question": "what is the late fee for rent?"}
    ).json()
    assert body["found"] is False
    assert body["mode"] == "extractive"
    assert any("$95" in s["quote"] for s in body["sources"])
