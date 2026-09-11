// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { isEditableTarget } from "./keyboard";

/** Parses `html` into the document body and returns its first element. */
function mount(html: string): Element {
  document.body.innerHTML = html;
  const element = document.body.firstElementChild;
  if (element === null) {
    throw new Error("fixture rendered no element");
  }
  return element;
}

function query(selector: string): Element {
  const element = document.querySelector(selector);
  if (element === null) {
    throw new Error(`fixture has no ${selector}`);
  }
  return element;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("isEditableTarget", () => {
  it("is false when the event carries no element", () => {
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(document)).toBe(false);
    expect(isEditableTarget(window)).toBe(false);
  });

  it("is false for ordinary elements that hold no text", () => {
    expect(isEditableTarget(mount("<div>body copy</div>"))).toBe(false);
    expect(isEditableTarget(mount("<button type='button'>Download</button>"))).toBe(false);
    expect(isEditableTarget(mount("<a href='/files'>Files</a>"))).toBe(false);
  });

  it("is true for a text-like input, whatever its exact type", () => {
    for (const type of ["text", "search", "email", "url", "tel", "password", "number", "date"]) {
      expect(isEditableTarget(mount(`<input type="${type}">`))).toBe(true);
    }
  });

  it("is true for an input with no type at all, which defaults to text", () => {
    expect(isEditableTarget(mount("<input>"))).toBe(true);
  });

  it("is true for an unrecognized input type, which browsers render as text", () => {
    expect(isEditableTarget(mount("<input type='frobnicate'>"))).toBe(true);
  });

  it("is true for a readonly input, whose caret still moves", () => {
    expect(isEditableTarget(mount("<input value='locked' readonly>"))).toBe(true);
  });

  it("is false for inputs that hold no text, so their shortcuts keep working", () => {
    for (const type of ["checkbox", "radio", "button", "submit", "reset", "file", "range"]) {
      expect(isEditableTarget(mount(`<input type="${type}">`))).toBe(false);
    }
  });

  it("is true for a textarea", () => {
    expect(isEditableTarget(mount("<textarea>draft</textarea>"))).toBe(true);
  });

  it("is true for a select, whose arrow keys change the chosen option", () => {
    expect(isEditableTarget(mount("<select><option>a</option></select>"))).toBe(true);
  });

  it("is true for a contenteditable host and for elements nested inside it", () => {
    mount("<div contenteditable='true'><p id='para'>typed <b id='bold'>text</b></p></div>");
    expect(isEditableTarget(query("[contenteditable]"))).toBe(true);
    expect(isEditableTarget(query("#para"))).toBe(true);
    expect(isEditableTarget(query("#bold"))).toBe(true);
  });

  it("is true for a bare contenteditable attribute, which means true", () => {
    expect(isEditableTarget(mount("<div contenteditable>typed</div>"))).toBe(true);
  });

  it("is false for contenteditable='false' and for its subtree", () => {
    mount("<div contenteditable='FALSE'><span id='inner'>static</span></div>");
    expect(isEditableTarget(query("[contenteditable]"))).toBe(false);
    expect(isEditableTarget(query("#inner"))).toBe(false);
  });

  it("is false inside a contenteditable='false' island within an editable host", () => {
    mount(
      "<div contenteditable='true'><span id='island' contenteditable='false'>chip</span></div>",
    );
    expect(isEditableTarget(query("#island"))).toBe(false);
  });

  it("is false for an element outside any contenteditable host", () => {
    mount("<section><div contenteditable='true'>note</div><span id='sibling'>x</span></section>");
    expect(isEditableTarget(query("#sibling"))).toBe(false);
  });

  it("is false for a non-HTML element, such as an icon's SVG node", () => {
    mount("<svg aria-hidden='true'><circle id='dot' /></svg>");
    expect(isEditableTarget(query("#dot"))).toBe(false);
  });

  it("is true for a non-HTML element inside a contenteditable host", () => {
    mount("<div contenteditable='true'><svg><circle id='glyph' /></svg></div>");
    expect(isEditableTarget(query("#glyph"))).toBe(true);
  });

  it("prefers the browser's resolved isContentEditable over the attribute", () => {
    // Real browsers inherit editability onto descendants without repeating
    // the attribute; jsdom does not, so this asserts the property is read
    // first by faking exactly what a browser would report.
    const element = mount("<div>inherited</div>");
    Object.defineProperty(element, "isContentEditable", { value: true, configurable: true });
    expect(isEditableTarget(element)).toBe(true);
  });
});
