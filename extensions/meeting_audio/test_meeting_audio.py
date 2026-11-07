"""meeting_audio 隔离测试：合成数据，不加载真实模型、不联网。

真实模型/语音的端到端冒烟见 smoke_local.py（需先装依赖与模型后手动运行）。
"""
import unittest
import tempfile
import shutil
from pathlib import Path
from unittest import mock

import numpy as np

import meeting_audio as ma


class CosineTests(unittest.TestCase):
    def test_same_vector(self):
        self.assertAlmostEqual(ma.cosine([1, 0, 0], [1, 0, 0]), 1.0, places=5)

    def test_orthogonal(self):
        self.assertAlmostEqual(ma.cosine([1, 0], [0, 1]), 0.0, places=5)

    def test_zero_denominator(self):
        self.assertEqual(ma.cosine([0, 0], [1, 1]), 0.0)


class WavRoundTripTests(unittest.TestCase):
    def test_write_and_load(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "x.wav"
            pcm = (np.sin(2 * np.pi * 440 * np.arange(16000) / 16000)).astype(np.float32) * 0.2
            ma._write_wav(pcm, 16000, p)
            loaded = ma.load_audio(p)
            self.assertGreater(loaded.size, 0)
            self.assertGreater(float(np.max(np.abs(loaded))), 0.05)  # 非静音、非近零


class ProfileStoreTests(unittest.TestCase):
    def setUp(self):
        self._orig = ma.PROFILE_DIR
        self._orig_load = ma.load_audio
        self._orig_extract = ma.extract_embedding
        self._tmp = Path(tempfile.mkdtemp(prefix="hgh_spk_"))
        ma.PROFILE_DIR = self._tmp / "profiles"

    def tearDown(self):
        ma.PROFILE_DIR = self._orig
        ma.load_audio = self._orig_load
        ma.extract_embedding = self._orig_extract
        shutil.rmtree(self._tmp, ignore_errors=True)

    def test_enroll_and_list(self):
        # 用替身替换声纹提取，避免加载模型
        ma.extract_embedding = lambda pcm, sr=16000: list(np.zeros(16, dtype=np.float32))
        ma.load_audio = lambda path: np.zeros(16000 * 2, dtype=np.float32)
        out = ma.enroll("fake.wav", "张三")
        self.assertEqual(out["name"], "张三")
        self.assertTrue(out["speaker_id"])
        self.assertEqual(len(ma.list_speakers()), 1)

    def test_delete(self):
        ma.extract_embedding = lambda pcm, sr=16000: list(np.zeros(16, dtype=np.float32))
        ma.load_audio = lambda path: np.zeros(16000 * 2, dtype=np.float32)
        out = ma.enroll("fake.wav", "李四")
        self.assertTrue(ma.delete_speaker(out["speaker_id"]))
        self.assertEqual(ma.list_speakers(), [])


class IdentifyLogicTests(unittest.TestCase):
    def test_match_above_threshold(self):
        profiles = {"a": {"name": "王五", "embedding": [1, 0, 0]}}
        # 用与注册向量接近的替身
        with mock.patch.object(ma, "extract_embedding", return_value=[1, 0, 0]):
            hit = ma.identify(np.zeros(16000, dtype=np.float32), profiles, threshold=0.6)
        self.assertTrue(hit["matched"])
        self.assertEqual(hit["name"], "王五")

    def test_no_match_below_threshold(self):
        profiles = {"a": {"name": "王五", "embedding": [1, 0, 0]}}
        with mock.patch.object(ma, "extract_embedding", return_value=[0, 1, 0]):
            hit = ma.identify(np.zeros(16000, dtype=np.float32), profiles, threshold=0.6)
        self.assertFalse(hit["matched"])


if __name__ == "__main__":
    unittest.main()
