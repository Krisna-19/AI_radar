const fs = require("fs");
const path = require("path");
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const ROOT = path.resolve(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

const PROD_FILES = [
  "index.html",
  "js/app.js",
  "js/dashboard.js",
  "js/history.js",
  "js/radar-view.js",
  "js/article.js",
];

const CARD_FILES = ["js/app.js", "js/history.js"];

describe("Production frontend source has no external article navigation", () => {
  for (const file of PROD_FILES) {
    it(`${file} contains no target="_blank" attribute`, () => {
      const src = read(file);
      assert.ok(
        !src.includes('target="_blank"'),
        `${file} still contains target="_blank"`
      );
    });

    it(`${file} contains no window.open`, () => {
      const src = read(file);
      assert.ok(!src.includes("window.open"), `${file} still contains window.open`);
    });

    it(`${file} contains no window.location assignment`, () => {
      const src = read(file);
      assert.ok(
        !src.includes("window.location"),
        `${file} still contains window.location`
      );
    });
  }

  for (const file of CARD_FILES) {
    it(`${file} contains no "Read ·" external source row`, () => {
      const src = read(file);
      assert.ok(
        !src.includes("Read ·") && !src.includes("Read \\u00b7"),
        `${file} still contains a Read · source row`
      );
    });

    it(`${file} contains no publisher-domain literals from the old Read row`, () => {
      const src = read(file);
      for (const literal of ["wired.com", "news.google.com", "theverge.com"]) {
        assert.ok(
          !src.includes(literal),
          `${file} still contains ${literal} in card-rendering source`
        );
      }
    });

    it(`${file} contains no card-link overlay`, () => {
      const src = read(file);
      assert.ok(!src.includes("card-link"), `${file} still contains card-link`);
    });

    it(`${file} contains no domainFromLink helper`, () => {
      const src = read(file);
      assert.ok(!src.includes("domainFromLink"), `${file} still contains domainFromLink`);
    });
  }

  it("radar-view.js contains no 'Read original source' link", () => {
    const src = read("js/radar-view.js");
    assert.ok(
      !src.includes("Read original source"),
      "radar-view.js still contains Read original source"
    );
  });
});

describe("Feed cards are wired as internal article openers", () => {
  it("app.js cardHtml emits data-story-id", () => {
    const src = read("js/app.js");
    assert.ok(src.includes('data-story-id'), "app.js cardHtml missing data-story-id");
  });

  it("app.js cardHtml includes aria-label for AI Radar", () => {
    const src = read("js/app.js");
    assert.ok(
      src.includes("Read story inside AI Radar"),
      "app.js cardHtml missing AI Radar aria-label"
    );
  });

  it("app.js topStoryHtml is a div (not an anchor) with data-story-id", () => {
    const src = read("js/app.js");
    assert.ok(
      src.includes('<div class="top-card'),
      "top-card is not rendered as a div element"
    );
    assert.ok(
      !src.includes('<a class="top-card'),
      "top-card is still an anchor element"
    );
    assert.ok(src.includes("data-story-id"), "top-card missing data-story-id");
  });

  it("dashboard.js signal-link is a span with data-story-id", () => {
    const src = read("js/dashboard.js");
    assert.ok(
      src.includes('class="signal-link" data-story-id'),
      "dashboard.js signal-link missing data-story-id span"
    );
    assert.ok(
      !src.includes('class="signal-link" href="'),
      "dashboard.js signal-link is still an anchor with href"
    );
  });

  it("history.js cardHtml emits data-story-id", () => {
    const src = read("js/history.js");
    assert.ok(src.includes('data-story-id'), "history.js cardHtml missing data-story-id");
  });

  it("history.js has openStory wiring to AIRadarArticle", () => {
    const src = read("js/history.js");
    assert.ok(
      src.includes("AIRadarArticle.open"),
      "history.js missing AIRadarArticle.open call"
    );
  });
});

describe("Internal article reader exists and is wired into index.html", () => {
  it("index.html loads css/article.css", () => {
    const src = read("index.html");
    assert.ok(src.includes('href="css/article.css'), "article.css not linked in index.html");
  });

  it("index.html contains #article-view section", () => {
    const src = read("index.html");
    assert.ok(src.includes('id="article-view"'), "article-view section missing");
  });

  it("index.html loads js/article.js before router.js", () => {
    const src = read("index.html");
    const articleIdx = src.indexOf('src="js/article.js');
    const routerIdx = src.indexOf('src="js/router.js');
    assert.ok(articleIdx !== -1, "js/article.js not loaded");
    assert.ok(routerIdx !== -1, "js/router.js not loaded");
    assert.ok(articleIdx < routerIdx, "js/article.js must load before router.js");
  });

  it("article.js defines readerHtml with content-priority rendering", () => {
    const src = read("js/article.js");
    assert.ok(src.includes("function readerHtml("), "readerHtml not defined");
    assert.ok(
      src.includes("Full story"),
      "readerHtml missing Full story label for extracted content"
    );
    assert.ok(
      src.includes("Description"),
      "readerHtml missing Description label for description fallback"
    );
  });

  it("article.js defines the esc() sanitizer", () => {
    const src = read("js/article.js");
    assert.ok(src.includes("function esc("), "esc sanitizer not defined");
    assert.ok(src.includes("&amp;"), "esc must convert & to &amp;");
    assert.ok(src.includes("&lt;"), "esc must convert < to &lt;");
  });

  it("article.js defines the back-to-feed button markup", () => {
    const src = read("js/article.js");
    assert.ok(
      src.includes("data-article-close"),
      "data-article-close not found in article.js"
    );
    assert.ok(
      src.includes("Back to feed"),
      "Back to feed text not found in article.js"
    );
  });

  it("article.js wire-up into the body is not vulnerable to injection", () => {
    const src = read("js/article.js");
    assert.ok(!src.includes("innerHTML += body") , "raw innerHTML += body found");
  });
});

describe("CSS: article-view has responsive rules", () => {
  it("css/article.css contains a responsive breakpoint", () => {
    const src = read("css/article.css");
    assert.ok(
      src.includes("@media"),
      "article.css has no responsive media queries"
    );
  });

  it("css/article.css hides other views when article is active", () => {
    const src = read("css/article.css");
    assert.ok(
      src.includes("body.article-active"),
      "article.css missing body.article-active exclusivity"
    );
  });
});

describe("Footer no longer claims external linking", () => {
  it("index.html footer does not say 'Headlines link to the original publishers'", () => {
    const src = read("index.html");
    assert.ok(
      !src.includes("Headlines link to the original publishers"),
      "footer still claims external linking"
    );
  });
});
