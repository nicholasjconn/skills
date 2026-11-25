import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from code_review import FileDiff, render


class InlineHighlights(unittest.TestCase):
    def changed_rows(self, before, after):
        patch = f"@@ -1 +1 @@\n-{before}\n+{after}\n".encode()
        file = FileDiff("values.txt", "values.txt", "M", (patch,))
        render([file])
        return [row for row in file.rendered if row["kind"] in ("remove", "add")]

    def test_preserves_repeated_tokens_between_two_edits(self):
        for indices in ((20, 90), (55, 105)):
            with self.subTest(indices=indices):
                values = ["0"] * 121
                before = "😀 " + ", ".join(values)
                for index in indices:
                    values[index] = "1"
                rows = self.changed_rows(before, "😀 " + ", ".join(values))
                expected = [(3 + index * 3, 4 + index * 3) for index in indices]
                self.assertEqual([row["inline_changes"] for row in rows], [expected, expected])

    def test_oversized_token_lists_still_render_the_diff(self):
        rows = self.changed_rows("0, " * 160 + "old", "0, " * 160 + "new")
        self.assertEqual([row["text"][-3:] for row in rows], ["old", "new"])
        self.assertTrue(all("inline_changes" not in row for row in rows))

    def test_tied_alignment_highlights_replaced_punctuation_in_place(self):
        rows = self.changed_rows("----", "--+-")
        self.assertEqual([row["inline_changes"] for row in rows], [[(2, 3)], [(2, 3)]])

    def test_tied_alignment_preserves_shifted_arguments(self):
        before = "f(firstArgument, secondArgument, thirdArgument)"
        after = "f(secondArgument, thirdArgument, firstArgument)"
        rows = self.changed_rows(before, after)
        marked = [[row["text"][start:end] for start, end in row["inline_changes"]] for row in rows]
        self.assertEqual(marked, [["firstArgument, "], [", firstArgument"]])
