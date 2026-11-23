import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.dont_write_bytecode = True
PLUGIN = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PLUGIN))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import fake_hook  # noqa: E402
import redact  # noqa: E402

# Made up for these tests.
NAME = "Maren Holloway"
EMAIL = "maren.holloway@example.org"
API_KEY = "sk-ant-api03-Zq7XvB2mN9pL4kR8tY1wE6uI3oA5sD0f"
SECRETS = (NAME, "Holloway", EMAIL, API_KEY)


def hook_input(text, attachments=(), unshown=()):
    return json.dumps(
        {
            "version": 1,
            "event": "before-send",
            "message": {"text": text, "attachments": list(attachments)},
            "unshownAttachments": list(unshown),
            "context": {"projectId": "p", "threadId": "t", "source": "web"},
        }
    )


DRAFT = f"Please review the lease for {NAME}. Reach her at {EMAIL}; the deploy key is {API_KEY}."
ATTACHMENT = {
    "id": "att-1",
    "name": "notes.txt",
    "text": f"Client: {NAME}\nEmail: {EMAIL}\nOPENAI_API_KEY={API_KEY}\nHolloway signed on Monday.\n",
}


def enter(test, context):
    value = context.__enter__()
    test.addCleanup(context.__exit__, None, None, None)
    return value


def ready_folder(test):
    """A model folder whose files match a patched MODEL_FILES, so verification passes."""
    folder = Path(enter(test, tempfile.TemporaryDirectory()))
    hashes = {}
    for name in redact.MODEL_FILES:
        (folder / name).write_bytes(name.encode())
        hashes[name] = hashlib.sha256(name.encode()).hexdigest()
    enter(test, mock.patch.dict(redact.MODEL_FILES, hashes, clear=True))
    return folder


class DecideTest(unittest.TestCase):
    def test_rewrites_name_email_and_key_in_draft_and_attachment(self):
        answer = redact.decide(hook_input(DRAFT, [ATTACHMENT]), ready_folder(self), load=fake_hook.fake_load)
        self.assertEqual(answer["decision"], "rewrite")
        out = json.dumps(answer)
        for secret in SECRETS:
            self.assertNotIn(secret, out)
        text = answer["message"]["text"]
        attachment = answer["message"]["attachments"][0]
        self.assertEqual(attachment["id"], "att-1")
        self.assertIn("[PERSON_1]", text)
        self.assertIn("[EMAIL_1]", text)
        self.assertIn("[CREDENTIAL_1]", text)
        # One value gets one placeholder across the text and its attachments.
        self.assertIn("Client: [PERSON_1]", attachment["text"])
        self.assertIn("[PERSON_2] signed on Monday.", attachment["text"])
        self.assertIn("OPENAI_API_KEY=[CREDENTIAL_1]", attachment["text"])

    def test_nothing_found_passes(self):
        answer = redact.decide(
            hook_input("Refactor the parser.", [{"id": "a", "name": "x.txt", "text": "plain"}]),
            ready_folder(self),
            load=fake_hook.fake_load,
        )
        self.assertEqual(answer, {"decision": "pass"})

    def assertBlocks(self, answer, *phrases):
        self.assertEqual(answer["decision"], "block")
        for phrase in phrases:
            self.assertIn(phrase, answer["reason"])
        for secret in SECRETS:
            self.assertNotIn(secret, answer["reason"])

    def test_missing_weights_blocks_with_setup_command(self):
        folder = Path(enter(self, tempfile.TemporaryDirectory()))
        answer = redact.decide(hook_input(DRAFT), folder, load=fake_hook.fake_load)
        self.assertBlocks(answer, "not downloaded", "setup_env.py")

    def test_weights_sha256_mismatch_blocks_with_setup_command(self):
        folder = ready_folder(self)
        (folder / "model.safetensors").write_bytes(b"tampered")
        answer = redact.decide(hook_input(DRAFT), folder, load=fake_hook.fake_load)
        self.assertBlocks(answer, "model.safetensors does not match", "setup_env.py")

    def test_unsupported_attachment_blocks_and_says_to_remove_it(self):
        answer = redact.decide(
            hook_input(DRAFT, [ATTACHMENT], [{"id": "img", "name": "scan.png"}]),
            ready_folder(self),
            load=fake_hook.fake_load,
        )
        self.assertBlocks(answer, "scan.png", "Remove it")

    def test_detector_exception_blocks_without_quoting_the_text(self):
        def load(_folder):
            def detect(text, _deadline):
                raise RuntimeError(f"failed on {text}")

            return detect

        answer = redact.decide(hook_input(DRAFT), ready_folder(self), load=load)
        self.assertBlocks(answer, "RuntimeError", "Send it again", "setup_env.py")

    def test_missing_dependencies_block_with_setup_command(self):
        def load(_folder):
            raise redact.Blocked(f"torch or transformers is missing. To fix it, {redact.setup_hint()}.")

        answer = redact.decide(hook_input(DRAFT), ready_folder(self), load=load)
        self.assertBlocks(answer, "missing", "setup_env.py")

    @unittest.skipIf(
        any(__import__("importlib").util.find_spec(m) for m in ("torch", "transformers")),
        "torch or transformers is installed here",
    )
    def test_load_detector_without_torch_blocks(self):
        with self.assertRaises(redact.Blocked) as caught:
            redact.load_detector(ready_folder(self))
        self.assertIn("setup_env.py", str(caught.exception))

    def test_detection_past_the_deadline_blocks(self):
        seen = []

        def load(_folder):
            def detect(_text, deadline):
                seen.append(deadline)
                raise TimeoutError

            return detect

        answer = redact.decide(hook_input(DRAFT), ready_folder(self), load=load, clock=lambda: 100.0)
        self.assertEqual(seen, [100.0 + redact.DETECT_DEADLINE_SECONDS])
        self.assertBlocks(answer, "in time", "Split it")

    def test_too_long_blocks_before_loading_the_model(self):
        answer = redact.decide(
            hook_input("x" * (redact.MAX_TOTAL_CHARS + 1)),
            ready_folder(self),
            load=lambda _folder: self.fail("the model should not load"),
        )
        self.assertBlocks(answer, "Split it")

    def test_unreadable_input_blocks(self):
        for raw in ("not json", b"\xff\xfe", json.dumps({"message": {"text": 3}})):
            self.assertBlocks(redact.decide(raw, ready_folder(self), load=fake_hook.fake_load), "could not read")


class RulesTest(unittest.TestCase):
    def test_rules_find_structured_identifiers_and_credentials(self):
        cases = [
            ("email", "write to a.b+c@mail.example.co.uk today", "a.b+c@mail.example.co.uk"),
            ("phone", "call +1 415 555 0132 now", "+1 415 555 0132"),
            ("phone", "手机 13812345678 联系", "13812345678"),
            ("phone", "office (415) 555-0132", "(415) 555-0132"),
            ("id", "身份证号 11010119900307123X 已核验", "11010119900307123X"),
            ("id", "统一社会信用代码 91330106MA2CF1XB4N", "91330106MA2CF1XB4N"),
            ("credential", "key sk-proj-AbCdEfGh1234567890xyz", "sk-proj-AbCdEfGh1234567890xyz"),
            ("credential", "token ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789", "ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789"),
            ("credential", "aws AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPLE"),
            ("credential", "Authorization: Bearer abcdef0123456789abcdef", "abcdef0123456789abcdef"),
            ("credential", 'password = "hunter2hunter2"', "hunter2hunter2"),
            ("credential", "hf hf_abcdefghijklmnopqrstuvwxyz0123456789", "hf_abcdefghijklmnopqrstuvwxyz0123456789"),
        ]
        for label, text, value in cases:
            with self.subTest(text=text):
                found = [(s["label"], text[s["start"] : s["end"]]) for s in redact.merge_spans(redact.rule_spans(text))]
                self.assertIn((label, value), found)

    def test_plain_text_matches_no_rule(self):
        for text in ("version 2.14.1 shipped", "see issue #195 and PR 196", "2026-11-22 at 18:00"):
            with self.subTest(text=text):
                self.assertEqual(redact.rule_spans(text), [])

    # Per label: (text, value it must mask) and texts where nothing of that label may be found.
    # Every number is invented; the IBANs are the published example ones.
    LEGAL_RULES = {
        "case_number": (
            [
                ("本院受理原告诉被告一案，案号（2024）京0105民初12345号。", "（2024）京0105民初12345号"),
                ("见(2023)最高法民申1234号裁定", "(2023)最高法民申1234号"),
                ("〔2015〕沪02民终567号之一判决", "〔2015〕沪02民终567号之一"),
                ("（2022）粤03执恢88号", "（2022）粤03执恢88号"),
            ],
            ["2024年京沪高铁12345号列车", "（2024）年度报告第3号", "第12345号文件"],
        ),
        "bank_account": (
            [
                ("账号：6222 0212 3456 7890 128", "6222 0212 3456 7890 128"),
                ("开户银行：中国银行，账号 110908765432101", "110908765432101"),
                ("Account No. 0123456789012", "0123456789012"),
                ("请汇至6280139980014397，谢谢", "6280139980014397"),
                ("卡号 6259611194799445885", "6259611194799445885"),
                ("card 6221 6702 4921 4941 on file", "6221 6702 4921 4941"),
            ],
            # The same numbers with one digit changed fail Luhn; short or keyword-free numbers stay.
            ["请汇至6280139980014398，谢谢", "6259611194799445886", "card 6221 6702 4921 4942", "账号尾号1234", "订单号20241122000012345678"],
        ),
        "iban": (
            [
                ("IBAN: DE89 3704 0044 0532 0130 00", "DE89 3704 0044 0532 0130 00"),
                ("pay GB82WEST12345698765432 today", "GB82WEST12345698765432"),
                ("IBAN FR1420041010050500013M02606", "FR1420041010050500013M02606"),
                ("NL91ABNA0417164300", "NL91ABNA0417164300"),
            ],
            ["IBAN: DE89 3704 0044 0532 0130 01", "GB82WEST12345698765433", "NL92ABNA0417164300", "AB12 CDEF GHIJ"],
        ),
        "amount": (
            [
                ("支付货款人民币500,000.00元", "人民币500,000.00元"),
                ("赔偿50万元", "50万元"),
                ("人民币伍拾万元整", "人民币伍拾万元整"),
                ("合计壹佰贰拾叁元肆角伍分", "壹佰贰拾叁元肆角伍分"),
                ("price ￥1,234.5 each", "￥1,234.5"),
                ("USD 2,000,000 in escrow", "USD 2,000,000"),
                ("a fee of $1,200", "$1,200"),
                ("违约金3000元", "3000元"),
            ],
            ["echo $1 and $HOME", "万元户", "共计3份", "第2.5节", "版本 2.14.1"],
        ),
        "plate": (
            [
                ("车牌号京A12345的车辆", "京A12345"),
                ("新能源车沪AD12345", "沪AD12345"),
                ("粤B·12345", "粤B·12345"),
                ("鲁B12345挂", "鲁B12345"),
            ],
            ["京ABCDEF", "苏E2024", "京A1234", "京I12345"],
        ),
        "lawyer_licence": (
            [
                ("律师执业证号11101200510123456", "11101200510123456"),
                ("执业证号：13101200910447012。", "13101200910447012"),
            ],
            ["11101185010123456", "1110120051012345", "111012005101234567", "07101200510123456"],
        ),
        "property_certificate": (
            [
                ("京（2020）朝阳区不动产权第0012345号", "京（2020）朝阳区不动产权第0012345号"),
                ("苏(2021)南京市不动产证明第0098765号", "苏(2021)南京市不动产证明第0098765号"),
                ("房产证号：京房权证朝字第123456号", "京房权证朝字第123456号"),
                ("沪房地产权证浦字第2019012345号", "沪房地产权证浦字第2019012345号"),
                ("原证号沪房地浦字（2008）第045678号", "沪房地浦字（2008）第045678号"),
            ],
            ["不动产权登记第3号", "房权证明", "京（2020）朝阳区不动产", "京房管字第1234号通知"],
        ),
    }

    def test_legal_rules_positive_and_negative_examples(self):
        for label, (positives, negatives) in self.LEGAL_RULES.items():
            for text, value in positives:
                with self.subTest(label=label, text=text):
                    found = [(s["label"], text[s["start"] : s["end"]]) for s in redact.merge_spans(redact.rule_spans(text))]
                    self.assertIn((label, value), found)
            for text in negatives:
                with self.subTest(label=label, negative=text):
                    self.assertEqual([s for s in redact.rule_spans(text) if s["label"] == label], [])

    def test_an_id_number_passing_luhn_stays_an_id(self):
        # 18 digits shaped like a resident ID that also pass Luhn: the ID rule names it.
        text = "身份证 440101199003071236"
        self.assertTrue(redact._luhn("440101199003071236"))
        spans = redact.merge_spans(redact.rule_spans(text))
        self.assertEqual([(s["label"], text[s["start"] : s["end"]]) for s in spans], [("id", "440101199003071236")])

    def test_overlapping_spans_merge_into_one_placeholder(self):
        text = f"mail {EMAIL} please"

        def detect(t, _deadline):
            start = t.index("maren")
            return [{"start": start, "end": start + 12, "label": "contact"}]

        out = redact.redact_text(text, detect, float("inf"), redact.Placeholders())
        self.assertEqual(out, "mail [EMAIL_1] please")

    def test_a_rule_names_a_span_the_model_finds_exactly(self):
        text = "案号（2024）京0105民初12345号，车辆京A12345"
        detect = tagging("（2024）京0105民初12345号", "京A12345", label="id")
        self.assertEqual(redact_all([text], detect), ["案号[CASE_NUMBER_1]，车辆[PLATE_1]"])


def tagging(*fragments, label="person"):
    """A fake detector that tags every occurrence of each fragment, as veil-detect tags subwords."""

    def detect(text, _deadline):
        spans = []
        for fragment in fragments:
            start = text.find(fragment)
            while start >= 0:
                spans.append({"start": start, "end": start + len(fragment), "label": label})
                start = text.find(fragment, start + 1)
        return spans

    return detect


def redact_all(texts, detect):
    return redact.redact_all(texts, detect, float("inf"), redact.Placeholders())


class SpanTest(unittest.TestCase):
    def test_a_subword_span_widens_to_the_whole_word(self):
        self.assertEqual(redact_all(["Holloway signed on Monday."], tagging("oway")), ["[PERSON_1] signed on Monday."])

    def test_spans_split_by_an_untagged_subword_join_into_one(self):
        # What veil-detect v1.0.0 does with this attachment: "Maren" and "oway" tagged, "Holl" not.
        out = redact_all(["Client: Maren Holloway\nEmail: none"], tagging("Maren", "oway"))
        self.assertEqual(out, ["Client: [PERSON_1]\nEmail: none"])
        out = redact_all(["Mar|en"], tagging("Mar", "en"))
        self.assertEqual(out, ["[PERSON_1]|[PERSON_2]"])
        self.assertEqual(redact_all(["Ma ren x"], tagging("Ma", "ren")), ["[PERSON_1] x"])

    def test_a_line_break_ends_a_span(self):
        out = redact_all(["Maren\nHolloway"], tagging("Maren", "Holloway"))
        self.assertEqual(out, ["[PERSON_1]\n[PERSON_2]"])

    def test_a_value_found_in_one_text_is_replaced_in_all_name_parts_included(self):
        draft = f"Review the lease for {NAME}."
        notes = f"Client: {NAME}\nHolloway signed. Maren paid. Hollowayville and Marenko are places."
        out = redact_all([draft, notes], tagging(NAME))
        self.assertEqual(out[0], "Review the lease for [PERSON_1].")
        self.assertEqual(
            out[1], "Client: [PERSON_1]\n[PERSON_2] signed. [PERSON_3] paid. Hollowayville and Marenko are places."
        )

    def test_name_parts_shorter_than_three_letters_stay(self):
        out = redact_all(["Al Holloway", "Al wrote to Holloway"], tagging("Al Holloway"))
        self.assertEqual(out, ["[PERSON_1]", "Al wrote to [PERSON_2]"])

    def test_a_rule_value_is_replaced_everywhere_but_not_inside_another_word(self):
        out = redact_all([f"key {API_KEY}", f"again {API_KEY} and x{API_KEY}y"], tagging())
        self.assertEqual(out[0], "key [CREDENTIAL_1]")
        self.assertTrue(out[1].startswith("again [CREDENTIAL_1] and x"))

    def test_cjk_spans_do_not_widen_across_the_line(self):
        self.assertEqual(redact_all(["客户张三已签约"], tagging("张三")), ["客户[PERSON_1]已签约"])

    def test_punctuation_the_model_tags_at_a_span_edge_stays_in_the_text(self):
        # veil-detect v1.0.0 tags "13812345678）" and "11101201810123456）".
        cases = [
            ("联系人（电话13812345678）稍后", tagging("13812345678）", label="contact"), "联系人（电话[PHONE_1]）稍后"),
            ("律师（执业证号11101201810123456）代理", tagging("11101201810123456）", label="id"), "律师（执业证号[LAWYER_LICENCE_1]）代理"),
            ("签约方：张三，", tagging("张三，"), "签约方：[PERSON_1]，"),
            ("Acme (HK) signed", tagging("Acme (HK)", label="organization"), "[ORGANIZATION_1] signed"),
            ("Maren!", tagging("!"), "Maren!"),
        ]
        for text, detect, expected in cases:
            with self.subTest(text=text):
                self.assertEqual(redact_all([text], detect), [expected])


def run_hook(script, stdin, *args, env=None):
    return subprocess.run(
        [sys.executable, str(script), *args], input=stdin.encode(), capture_output=True, env=env, timeout=60, check=False
    )


def files_under(*roots):
    return {path for root in roots for path in Path(root).rglob("*") if path.is_file()}


class ProcessTest(unittest.TestCase):
    def isolated_env(self):
        home = enter(self, tempfile.TemporaryDirectory())
        env = {**os.environ, "HOME": home, "TMPDIR": home, "TEMP": home, "TMP": home}
        env["AGENTD_REDACT_DATA_DIR"] = str(Path(home) / "data")
        return home, env

    def test_hook_writes_no_file_and_nothing_to_stderr(self):
        home, env = self.isolated_env()
        before = files_under(home, PLUGIN)
        result = run_hook(PLUGIN / "tests" / "fake_hook.py", hook_input(DRAFT, [ATTACHMENT]), env=env)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stderr, b"")
        self.assertEqual(json.loads(result.stdout)["decision"], "rewrite")
        self.assertEqual(files_under(home, PLUGIN), before)
        for secret in SECRETS:
            self.assertNotIn(secret.encode(), result.stdout)

    def test_hook_without_its_environment_blocks_with_setup_command(self):
        _home, env = self.isolated_env()
        result = run_hook(PLUGIN / "hook.py", hook_input(DRAFT), env=env)
        self.assertEqual(result.returncode, 0)
        answer = json.loads(result.stdout)
        self.assertEqual(answer["decision"], "block")
        self.assertIn("setup_env.py", answer["reason"])

    @unittest.skipIf(os.name == "nt", "symlinked interpreter")
    def test_hook_hands_off_to_the_venv_once_and_never_loops(self):
        _home, env = self.isolated_env()
        # A "venv" python that is really this interpreter: the child is not in the venv either.
        python = redact.venv_python(Path(env["AGENTD_REDACT_DATA_DIR"]))
        python.parent.mkdir(parents=True)
        python.symlink_to(sys.executable)
        result = run_hook(PLUGIN / "hook.py", hook_input(DRAFT), env=env)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout)["decision"], "block")


REAL_DATA = redact.data_dir()


@unittest.skipUnless(
    redact.venv_python(REAL_DATA).is_file() and (redact.model_dir(REAL_DATA) / "model.safetensors").is_file(),
    f"no veil-detect weights in {REAL_DATA}: run `python3 agentd/plugins/redact/setup_env.py` "
    "(set AGENTD_REDACT_DATA_DIR to put them elsewhere), then run these tests again",
)
class RealWeightsTest(unittest.TestCase):
    def test_real_model_redacts_within_the_hook_limit(self):
        started = time.monotonic()
        result = run_hook(PLUGIN / "hook.py", hook_input(DRAFT, [ATTACHMENT]))
        elapsed = time.monotonic() - started
        answer = json.loads(result.stdout)
        self.assertEqual(answer["decision"], "rewrite", answer.get("reason"))
        for secret in SECRETS:
            self.assertNotIn(secret, json.dumps(answer))
        self.assertLess(elapsed, 60)


if __name__ == "__main__":
    unittest.main()
