"""Approved plain-language wording for common discharge jargon.

The writer gets the entries that matter for each patient, and must write the plain words
first with the medical term after it in parentheses:

    "You had fluid in your lungs (pulmonary edema)."

Code checks that the first time a listed term appears in the plan, it sits inside
parentheses after plain words, not as the main word of the sentence.

Each plain phrase is a general meaning of the term. It must never say where an infection was,
what caused something, or any other fact about the patient; those come from the notes only.
The wording should be reviewed by a clinician before real patients use it.
"""

from __future__ import annotations

import re
from typing import Any

# term -> plain words. Longer, more specific terms are matched before shorter ones.
GLOSSARY: dict[str, str] = {
    # Infections
    "sepsis": "a very serious body reaction to an infection",
    "septic shock": "a very serious reaction to an infection that makes blood pressure drop too low",
    "community-acquired pneumonia": "a lung infection you got outside the hospital",
    "pneumonia": "a lung infection",
    "complicated urinary tract infection": "a hard-to-treat infection in the parts of your body that make and "
                                           "carry urine",
    "urinary tract infection": "an infection in the parts of your body that make and carry urine",
    "UTI": "an infection in the parts of your body that make and carry urine",
    "pyelonephritis": "a kidney infection",
    "cellulitis": "a skin infection",
    "infective endocarditis": "an infection inside your heart",
    "endocarditis": "an infection inside your heart",
    "osteomyelitis": "a bone infection",
    "abscess": "a pocket of pus",
    # Kidneys and urinary
    "acute kidney injury": "your kidneys suddenly stopped working as well as they should",
    "chronic kidney disease": "long-term kidney damage",
    "hydronephrosis": "swelling of the kidney because urine cannot drain",
    "ureteral calculus": "a kidney stone stuck in the tube that carries urine to the bladder",
    "ureteral stone": "a kidney stone stuck in the tube that carries urine to the bladder",
    "ureteral stent": "a small tube that keeps urine draining from the kidney",
    "ureter": "the tube that carries urine from the kidney to the bladder",
    "renal function": "kidney function",
    # Heart and blood vessels
    "acute on chronic heart failure": "long-term heart failure that suddenly got worse",
    "heart failure with reduced ejection fraction": "a heart that pumps weaker than normal",
    "heart failure with preserved ejection fraction": "a heart muscle that is stiff and does not fill well",
    "HFrEF": "a heart that pumps weaker than normal",
    "HFpEF": "a heart muscle that is stiff and does not fill well",
    "systolic heart failure": "a heart that pumps weaker than normal",
    "diastolic heart failure": "a heart muscle that is stiff and does not fill well",
    "ejection fraction": "how much blood your heart pumps out with each beat",
    "atrial fibrillation": "an uneven heartbeat",
    "paroxysmal atrial fibrillation": "an uneven heartbeat that comes and goes",
    "rapid ventricular response": "a fast heartbeat",
    "rate control": "keeping your heartbeat at a safe speed",
    "hypertension": "high blood pressure",
    "hyperlipidemia": "high cholesterol",
    "mitral regurgitation": "a leaky heart valve",
    "mitral valve": "one of the valves inside your heart",
    "vegetation": "a clump of germs growing on a heart valve",
    "echocardiogram": "an ultrasound picture of your heart",
    "thrombus": "a blood clot",
    "anticoagulant": "a blood thinner",
    "anticoagulation": "blood-thinning medicine",
    "dual antiplatelet therapy": "two medicines taken together to help stop blood clots",
    "antiplatelet": "a medicine that helps stop blood clots",
    "syncope": "fainting",
    # Lungs and breathing
    "pulmonary edema": "fluid in your lungs",
    "acute hypoxic respiratory failure": "very low oxygen in your blood from trouble breathing",
    "COPD": "a long-term lung disease that makes it hard to breathe",
    "exacerbation": "a flare-up, when it suddenly got worse",
    "orthopnea": "trouble breathing when lying flat",
    "dyspnea": "trouble breathing",
    "supplemental oxygen": "extra oxygen",
    # Brain
    "acute ischemic stroke": "a stroke caused by a blocked blood vessel in the brain",
    "ischemic stroke": "a stroke caused by a blocked blood vessel in the brain",
    "expressive aphasia": "trouble finding or saying words",
    "aphasia": "trouble with words or speech",
    "MCA territory": "an area of the brain fed by one main blood vessel",
    "hemorrhage": "bleeding",
    "thrombolysis": "clot-busting medicine",
    # Blood, sugar, other
    "anemia of chronic disease": "low red blood cells caused by a long-term illness",
    "anemia": "a low number of red blood cells",
    "type 2 diabetes mellitus": "type 2 diabetes, which causes high blood sugar",
    "diabetes mellitus": "diabetes, which causes high blood sugar",
    "hypoglycemia": "low blood sugar",
    "hyperglycemia": "high blood sugar",
    "edema": "swelling from extra fluid",
    "lower-extremity edema": "swelling in your legs",
    "tobacco use disorder": "a hard time stopping tobacco use",
    "volume management": "removing extra fluid from your body",
    "volume overload": "too much fluid in your body",
    "diuretic": "a water pill",
    "NSAIDs": "anti-inflammatory pain medicines",
    "thin liquids": "regular drinks",
    "regimen": "plan for taking a medicine",
    "medication reconciliation": "the final check of your medicine list",
    # Tests and devices
    "basic metabolic panel": "a blood test that checks your kidneys and body salts",
    "complete blood count": "a blood test that counts your blood cells",
    "CBC": "a blood test that counts your blood cells",
    "lipid panel": "a blood test for cholesterol",
    "liver function tests": "blood tests that check your liver",
    "electrolytes": "body salts",
    "creatinine": "a blood test that shows how well your kidneys work",
    "pulmonary function test": "a breathing test that checks how well your lungs work",
    "PICC": "a thin IV tube in your arm for medicine",
    "vascular access": "the IV line used for your medicine",
    "incentive spirometer": "a breathing exercise tool",
    "ambulatory cardiac monitor": "a heart monitor you wear at home",
}

# Everyday words that are still too hard for a 5th grader -> what to say instead. Checked by
# code, the same way every round, so the reading-level bar never moves.
HARD_WORDS: dict[str, str] = {
    "indefinitely": "with no stop date",
    "regimen": "plan",
    "prior": "before",
    "resolved": "got better",
    "chronic": "long-term",
    "formulation": "form",
    "discontinued": "stopped",
    "discontinue": "stop",
    "administer": "give",
    "adequate": "enough",
    "subsequently": "later",
    "intermittent": "now and then",
    "ambulate": "walk",
    "elevate": "raise",
    "cessation": "stopping",
    "adherence": "taking it the right way",
    "utilize": "use",
    "as directed": "the way your care team told you",
    "as prescribed": "the way your doctor told you",
    "as instructed": "the way your care team told you",
    "breakthrough symptoms": "sudden symptoms",
    "outpatient": "at a clinic after you go home",
    "inpatient": "in the hospital",
    "reconciliation": "final check of your medicines",
    "urinate": "pee",
    "urination": "peeing",
}


def hard_word_problems(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Lines that use a word from HARD_WORDS outside parentheses."""
    issues = []
    for e in entries:
        plain = _outside_parentheses(e["text"]).lower()
        hits = [w for w in HARD_WORDS if re.search(rf"(?<![\w-]){re.escape(w)}(?![\w-])", plain)]
        if hits:
            fixes = "; ".join(f"'{w}' -> '{HARD_WORDS[w]}'" for w in hits)
            issues.append({"text": f"TOO HARD FOR A 5TH GRADER: \"{e['text']}\" -- use everyday words: {fixes}.",
                           "lines": [e["id"]], "kind": "line", "group": ""})
    return issues


def hard_words_text() -> str:
    return "\n".join(f"- '{w}' -> '{r}'" for w, r in HARD_WORDS.items())


# A term followed by these words is a name ("heart failure team"), not jargon to explain.
_NAME_WORDS = r"team|clinic|doctor|doctors|nurse|program|office|plan|specialist|lab"


def _pattern(term: str) -> re.Pattern[str]:
    flags = 0 if term.isupper() else re.IGNORECASE  # acronyms like COPD or CBC match case-sensitively
    return re.compile(rf"(?<![\w-]){re.escape(term)}(?![\w-])(?!\s+(?:{_NAME_WORDS})\b)", flags)


_ORDERED = sorted(GLOSSARY, key=len, reverse=True)
_PATTERNS = {t: _pattern(t) for t in _ORDERED}


def glossary_for(notes: str) -> dict[str, str]:
    """Glossary entries for terms that appear in these notes."""
    return {t: GLOSSARY[t] for t in _ORDERED if _PATTERNS[t].search(notes)}


def _outside_parentheses(text: str) -> str:
    out, depth = [], 0
    for ch in text:
        if ch == "(":
            depth += 1
            out.append(" ")
        elif ch == ")":
            depth = max(0, depth - 1)
            out.append(" ")
        else:
            out.append(" " if depth else ch)
    return "".join(out)


def _terms_in(text: str) -> list[str]:
    """Glossary terms in text, longest first, without counting a shorter term inside a longer one."""
    found, taken = [], []
    for t in _ORDERED:
        for m in _PATTERNS[t].finditer(text):
            if not any(a <= m.start() < b for a, b in taken):
                taken.append((m.start(), m.end()))
                found.append(t)
    return list(dict.fromkeys(found))


def jargon_problems(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Lines where a jargon term appears for the first time WITHOUT plain words before it.

    The first use of each term must be inside parentheses after plain words. Later uses are
    fine, since the patient has already been told what it means.
    """
    issues, explained = [], set()
    for e in entries:
        outside = set(_terms_in(_outside_parentheses(e["text"])))
        inside = set(_terms_in(e["text"])) - outside
        for t in sorted(outside - explained, key=len, reverse=True):
            issues.append({
                "text": f"JARGON FIRST: \"{e['text']}\" -- '{t}' is a medical term. Put plain words first and the "
                        f"term after it in parentheses, for example \"{GLOSSARY[t]} ({t})\".",
                "lines": [e["id"]], "kind": "line", "group": "",
            })
        explained |= outside | inside
    return issues
