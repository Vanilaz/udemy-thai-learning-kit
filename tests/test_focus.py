"""Chunks are translated nearest the viewer first (seeking far ahead)."""

from __future__ import annotations

import threading
import unittest

from udemy_th.translate_agy import next_chunk


class NextChunkTests(unittest.TestCase):
    # Chunk start times in seconds, as a 10-minute lecture split in five.
    starts = [0.0, 120.0, 240.0, 360.0, 480.0]

    def test_without_a_focus_chunks_go_in_order(self):
        self.assertEqual(next_chunk({0, 1, 2, 3, 4}, self.starts, None), 0)
        self.assertEqual(next_chunk({2, 3}, self.starts, None), 2)

    def test_the_chunk_under_the_playhead_comes_first_then_the_runway_ahead(self):
        pending = {0, 1, 2, 3, 4}
        order = []
        while pending:
            index = next_chunk(pending, self.starts, 400.0)  # viewer jumped to 6:40
            order.append(index)
            pending.discard(index)
        # 360-480 holds 6:40, then what follows it, and only then the skipped part.
        self.assertEqual(order, [3, 4, 0, 1, 2])

    def test_a_focus_past_the_last_chunk_takes_the_last_chunk(self):
        self.assertEqual(next_chunk({0, 1, 2, 3, 4}, self.starts, 9999.0), 4)

    def test_untimed_chunks_keep_their_order(self):
        self.assertEqual(next_chunk({1, 2}, [None, None, None], 300.0), 1)


class FocusPlumbingTests(unittest.TestCase):
    def test_a_job_focus_is_read_by_the_translator_while_it_runs(self):
        from udemy_th import server

        server._set_focus("job-1", 300.0)
        self.assertEqual(server._focus_of("job-1")(), 300.0)
        self.assertIsNone(server._focus_of("job-2")())

    def test_focus_is_safe_to_update_from_another_thread(self):
        from udemy_th import server

        threads = [threading.Thread(target=server._set_focus, args=("job-3", float(t))) for t in range(50)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertIn(server._focus_of("job-3")(), {float(t) for t in range(50)})


if __name__ == "__main__":
    unittest.main()
