import os
import tempfile

# 測試一律使用離線示範資料與暫存資料夾
os.environ.setdefault("TWSTOCK_SOURCE", "demo")
os.environ.setdefault("TWSTOCK_DATA_DIR", tempfile.mkdtemp(prefix="twstock-test-"))
