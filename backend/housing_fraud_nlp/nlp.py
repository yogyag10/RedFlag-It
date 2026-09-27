"""spaCy pipeline loading and parsing helpers."""

from functools import lru_cache

import spacy
from spacy.language import Language
from spacy.tokens import Doc

MODEL_NAME = "en_core_web_sm"


@Language.component("newline_sentence_boundaries")
def newline_sentence_boundaries(doc: Doc) -> Doc:
    """Start a new sentence after every line break.

    Listings are often written as bullet lines without final punctuation, and
    the parser would otherwise merge them into one long sentence.
    """
    for token in doc[:-1]:
        if "\n" in token.text:
            doc[token.i + 1].is_sent_start = True
    return doc


@lru_cache(maxsize=1)
def get_nlp() -> Language:
    """Load the English pipeline once and reuse it."""
    try:
        nlp = spacy.load(MODEL_NAME)
    except OSError as error:
        raise OSError(
            f"spaCy model '{MODEL_NAME}' is not installed. "
            f"Run: python -m spacy download {MODEL_NAME}"
        ) from error
    nlp.add_pipe("newline_sentence_boundaries", before="parser")
    return nlp


@lru_cache(maxsize=512)
def parse(text: str) -> Doc:
    """Parse text once so several detectors can run on the same listing cheaply."""
    return get_nlp()(text)
