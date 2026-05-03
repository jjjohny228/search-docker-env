# balance.py
import os
from web3 import Web3
from dotenv import load_dotenv

load_dotenv()

# Подключаемся к Polygon
RPC_URL = "https://polygon-bor-rpc.publicnode.com"
w3 = Web3(Web3.HTTPProvider(RPC_URL))

# Адрес контракта USDC.e на Polygon
USDC_E_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"

# Минимальный ABI — только balanceOf и decimals
ABI = [
  {"name": "balanceOf", "type": "function",
   "inputs": [{"name": "account", "type": "address"}],
   "outputs": [{"type": "uint256"}]},
  {"name": "decimals", "type": "function",
   "inputs": [], "outputs": [{"type": "uint8"}]},
]

def get_balance(address: str) -> dict:
  """Возвращает баланс MATIC и USDC.e для адреса."""
  address = Web3.to_checksum_address(address)

  # MATIC (нативный токен)
  matic_wei = w3.eth.get_balance(address)
  matic = w3.from_wei(matic_wei, "ether")

  # USDC.e (ERC-20)
  contract = w3.eth.contract(address=USDC_E_ADDRESS, abi=ABI)
  raw = contract.functions.balanceOf(address).call()
  decimals = contract.functions.decimals().call()
  usdc = raw / 10 ** decimals

  return {"address": address, "MATIC": float(matic), "USDC.e": usdc}


if __name__ == "__main__":
  # Берём адрес из приватного ключа
  private_key = '84a6edb41f27f4ee8f587fa2112f784b8a06d482255efceef0a0c7fe0b227eb0'
  account = w3.eth.account.from_key(private_key)

  result = get_balance(account.address)
  print(f"Адрес: {result['address']}")
  print(f"MATIC: {result['MATIC']:.4f}")
  print(f"USDC.e: {result['USDC.e']:.2f}")
