# Fixtures

Real files written by independent tools, so the parsers are checked against
something other than the test suite's own builders. All of them were generated
for this crate; none is a third-party sample.

`report.*` come from the page below, saved as `report.html`:

```html
<html><head><meta charset="utf-8"><title>Kvartalsrapport</title></head><body>
<h1>Kvartalsrapport Q3</h1>
<p>Räksmörgåsar såldes för 1&nbsp;250 kr under tredje kvartalet.</p>
<p>See the <a href="https://example.com/report">full report</a> for details.</p>
<table><tr><th>Region</th><th>Intäkt</th></tr><tr><td>Norr</td><td>420</td></tr><tr><td>Söder</td><td>830</td></tr></table>
<h2>Nästa steg</h2>
<ul><li>Anställ två säljare</li><li>Öppna butik i Malmö</li></ul>
</body></html>
```

```sh
textutil -convert doc report.html -output report.doc
textutil -convert rtf report.html -output report.rtf
pandoc report.html -o report.docx
pandoc report.html -o report.odt
pandoc report.html -o report.epub
pandoc report.html -o report.pptx
```

`sales.xls` was written with Python's `xlwt` and `sales.xlsx` with `openpyxl`:
two sheets, text, numbers, booleans and dates in a `YYYY-MM-DD` format.
