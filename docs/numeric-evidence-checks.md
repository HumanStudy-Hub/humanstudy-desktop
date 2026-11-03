# Numeric evidence: rounded p-values and visual source limits

Reported p-values must be positive when stored numerically. A paper printing
`p = 0.00` or `p = 0.000` does not establish an exact probability of zero.
Preserve those digits in `reported.test.pText`, set `p` to null and explain the
missing exact value in `reported.missing`. This checker deliberately does not
infer `< .005` or `< .0005`: that would assume a rounding rule the document may
not state. A bound is valid when the cited source actually prints it. This rule
applies to p-values attached to estimates as well as to the reported test; zero
estimates or zero-valued test statistics remain legitimate values.

Wilcoxon signed-rank statistics printed as `V` are accepted without renaming
them `W`. Both statistic names remain available; this validates the reported
label and does not assert that two software implementations use identical
rank-sum conventions.

## What still requires visual verification

Quote agreement with a PDF text layer cannot certify numeric typography. A
superscript exponent can flatten into adjacent digits, so an extracted `104`
might represent a printed power of ten or the integer one hundred and four.
Similarly, an image-only page has no extractable quote text. The present changes
add no exception that converts either case into a verified machine match.

A future detector could inspect PDF word bounding boxes to flag raised tokens
adjacent to a base ending in `10`. Geometry alone cannot decide whether a raised
integer is an exponent, footnote, citation, or part of another symbol. Such a
candidate must retain the original token positions and be reviewed against the
rendered page; it must not silently merge tokens or correct an extracted value.
Absent glyph/text boxes cannot be treated as evidence that the page has no such
numbers.

A reliable visual-review record needs more than an agent-writable note saying
“rendered page checked” or a self-assigned `verification: verified`. It should
bind the exact source hash, physical page, rendered artifact hash, token/bounding
box region, raw extracted token sequence, proposed transcription, and reviewer
identity/decision through a trusted review channel. Source or transcription
changes must invalidate the decision. Scanned-page transcription additionally
needs a documented image-reading/OCR procedure and uncertainty per passage;
OCR output alone is not proof of correctness. Existing text-layer sign-loss
exceptions remain limited and are not expanded by this change.
