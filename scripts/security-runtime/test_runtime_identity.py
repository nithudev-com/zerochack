"""Pure/synthetic proc metadata tests. Never starts a process, engine or job."""
from pathlib import Path
import tempfile
import unittest

from provision import Refusal
from verify import MAX_PROCESS_METADATA_BYTES, process_identity, validate_process_identity


ALLOCATION = dict(dedicated_uid=997, dedicated_gid=986, subordinate_start=2000000, subordinate_count=65536)


def status(uid=997, gid=986):
    return f"Name:\trunsc-sentry\nUid:\t{uid}\t{uid}\t{uid}\t{uid}\nGid:\t{gid}\t{gid}\t{gid}\t{gid}\n"


def validate(text=None, uid_map="0 997 1\n", gid_map="0 986 1\n", **allocation):
    return validate_process_identity(status() if text is None else text, uid_map, gid_map,
                                     **(ALLOCATION | allocation))


class SandboxRuntimeIdentityTests(unittest.TestCase):
    def test_dedicated_host_ids_have_four_credentials_and_explicit_mapping(self):
        observed = validate()
        self.assertEqual(observed["uids"], dict(real=997, effective=997, saved=997, filesystem=997))
        self.assertEqual(observed["gids"], dict(real=986, effective=986, saved=986, filesystem=986))
        self.assertEqual(observed["uidMap"], [dict(inside=0, host=997, count=1)])
        self.assertEqual(observed["gidMap"], [dict(inside=0, host=986, count=1)])
        self.assertEqual(observed["processRole"], "sandbox-runtime-process-not-guest-python")

    def test_nested_nobody_maps_only_to_allocated_host_subordinate_ids(self):
        observed = validate(status(2065533, 2065533), "65534 2065533 1\n", "65534 2065533 1\n")
        self.assertEqual(observed["uids"]["effective"], 2065533)
        self.assertEqual(observed["uidMap"], [dict(inside=65534, host=2065533, count=1)])

    def test_full_rootless_mapping_is_allowed_with_allocated_ids_only(self):
        observed = validate(status(2000123, 2000456), "0 997 1\n1 2000000 65536\n", "0 986 1\n1 2000000 65536\n")
        self.assertEqual(len(observed["uidMap"]), 2)
        self.assertEqual(observed["gids"]["saved"], 2000456)

    def test_root_and_unrelated_ids_in_every_credential_field_are_rejected(self):
        for field in ("Uid", "Gid"):
            for index in range(4):
                for malicious in (0, 1000, 65534, 1999999, 2065536, 4294967295):
                    values = [997 if field == "Uid" else 986] * 4
                    values[index] = malicious
                    current = status()
                    old = next(line for line in current.splitlines() if line.startswith(field + ":"))
                    current = current.replace(old, field + ":\t" + "\t".join(map(str, values)))
                    with self.subTest(field=field, index=index, malicious=malicious), self.assertRaises(Refusal):
                        validate(current)

    def test_even_allowed_host_ids_must_be_present_in_actual_map(self):
        for text, uid_map, gid_map in ((status(2000001), "0 997 1\n", "0 986 1\n"),
                                      (status(gid=2000001), "0 997 1\n", "0 986 1\n"),
                                      (status(), "1 2000000 65536\n", "0 986 1\n")):
            with self.subTest(text=text), self.assertRaisesRegex(Refusal, "OUTSIDE_VERIFIED_MAP"):
                validate(text, uid_map, gid_map)

    def test_mixed_credentials_fail_closed_even_inside_one_allocation(self):
        text = status(2000001).replace("Uid:\t2000001\t2000001\t2000001\t2000001", "Uid:\t2000001\t2000002\t2000001\t2000001")
        with self.assertRaisesRegex(Refusal, "OUTSIDE_VERIFIED_MAP"):
            validate(text, "0 2000000 65536\n")

    def test_unrelated_root_or_boundary_crossing_mappings_are_rejected(self):
        for mapping in ("0 0 1\n", "0 1000 1\n", "0 65534 1\n", "0 997 2\n",
                        "0 1999999 2\n", "0 2065535 2\n", "0 2000000 65537\n",
                        "0 997 1\n1 1000 1\n", "0 4294967295 1\n", "4294967295 997 1\n"):
            for kind in ("uid", "gid"):
                with self.subTest(mapping=mapping, kind=kind), self.assertRaises(Refusal):
                    validate(uid_map=mapping) if kind == "uid" else validate(gid_map=mapping)

    def test_overlaps_and_duplicate_inner_or_host_ranges_are_rejected(self):
        for mapping in ("0 997 1\n0 2000000 1\n", "0 2000000 2\n1 2000010 2\n",
                        "0 2000000 2\n3 2000001 2\n", "0 997 1\n1 997 1\n"):
            with self.subTest(mapping=mapping), self.assertRaisesRegex(Refusal, "OVERLAPPING"):
                validate(uid_map=mapping)

    def test_missing_malformed_unbounded_or_non_ascii_metadata_is_rejected(self):
        for mapping in ("", "\n", "0 997 0\n", "-1 997 1\n", "0 997 1 extra\n",
                        "0 997 1\n\n", "0 997 1\x00", "0 997 1é", "0 997 1\n" * 341,
                        "0 997 1" + " " * MAX_PROCESS_METADATA_BYTES):
            with self.subTest(mapping=mapping[:30]), self.assertRaises(Refusal):
                validate(uid_map=mapping)
        for text in ("", "Name:\tsentry\n", status() + "Uid:\t997 997 997 997\n",
                     status().replace("Gid:", "Missing:"), status().replace("997\t997\t997\t997", "997 997 997"),
                     status() + "é", status() + " " * MAX_PROCESS_METADATA_BYTES):
            with self.subTest(text=text[:30]), self.assertRaises(Refusal):
                validate(text)

    def test_unreviewed_allocation_is_rejected(self):
        for allocation in (dict(dedicated_uid=0), dict(dedicated_gid=0), dict(dedicated_uid=True),
                           dict(subordinate_start=0), dict(subordinate_count=0),
                           dict(subordinate_start=4294967294, subordinate_count=2),
                           dict(subordinate_start=900, subordinate_count=65536)):
            with self.subTest(allocation=allocation), self.assertRaisesRegex(Refusal, "INVALID_DEDICATED"):
                validate(**allocation)

    def test_proc_reader_is_bounded_and_uses_all_three_actual_metadata_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            proc = Path(temporary)
            (proc / "status").write_text(status(2065533, 2065533))
            for name in ("uid_map", "gid_map"):
                (proc / name).write_text("65534 2065533 1\n")
            self.assertEqual(process_identity(proc, **ALLOCATION)["uids"]["real"], 2065533)
            (proc / "uid_map").write_bytes(b" " * (MAX_PROCESS_METADATA_BYTES + 1))
            with self.assertRaisesRegex(Refusal, "METADATA_LIMIT"):
                process_identity(proc, **ALLOCATION)


if __name__ == "__main__":
    unittest.main()
