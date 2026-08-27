from fastapi import APIRouter, FastAPI

app = FastAPI()
router = APIRouter()

@app.get("/accounts/{account_id}")
def get_account(account_id: int):
    return account_id

@router.post("/accounts")
def create_account():
    return True
