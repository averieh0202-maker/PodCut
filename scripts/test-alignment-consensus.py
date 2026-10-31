import unittest
from alignment_consensus import repair_short_tokens


class ConsensusTests(unittest.TestCase):
    def fixture(self):
        words = [{"text": "字", "start": i * .3, "end": i * .3 + .2, "review": False} for i in range(9)]
        stamps = [[(w["start"] + .08) * 1000, (w["end"] + .08) * 1000] for w in words]
        words[4].update(start=1.4, end=1.4, review=True)
        return words, stamps

    def test_repairs_short_word_with_calibrated_acoustic_span(self):
        words, stamps = self.fixture()
        result = repair_short_tokens(words, stamps, 3)
        self.assertEqual((result[4]["start"], result[4]["end"]), (1.2, 1.4))
        self.assertEqual(result[4]["source"], "fa-zh")
        self.assertTrue(words[4]["review"])

    def test_rejects_wrong_counts(self):
        words, stamps = self.fixture()
        self.assertEqual(repair_short_tokens(words, stamps[:-1], 3), words)

    def test_rejects_unstable_offsets(self):
        words, stamps = self.fixture()
        for i, pair in enumerate(stamps):
            pair[0] += 300 if i % 2 else -300
            pair[1] += 300 if i % 2 else -300
        self.assertEqual(repair_short_tokens(words, stamps, 3), words)

    def test_never_overwrites_confident_primary_alignment(self):
        words, stamps = self.fixture()
        result = repair_short_tokens(words, stamps, 3)
        for i in range(9):
            if i != 4:
                self.assertEqual(words[i], result[i])

    def test_rejects_overlap_and_unbracketed_short_words(self):
        words, stamps = self.fixture()
        stamps[4] = [900, 1600]
        self.assertTrue(repair_short_tokens(words, stamps, 3)[4]["review"])
        words[3]["review"] = True
        self.assertTrue(repair_short_tokens(words, self.fixture()[1], 3)[4]["review"])


if __name__ == "__main__":
    unittest.main()
