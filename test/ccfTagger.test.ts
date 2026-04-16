import { assert } from "chai";
import {
  detectCCFLevelByVenueNames,
  normalizeVenueName,
} from "../src/modules/ccfTagger";

describe("ccfTagger", function () {
  it("should normalize venue names", function () {
    assert.equal(
      normalizeVenueName(" ACM SIGMOD Conference on Management of Data "),
      "ACM SIGMOD CONFERENCE ON MANAGEMENT OF DATA",
    );
  });

  it("should detect CCF-A from conference aliases", function () {
    assert.equal(detectCCFLevelByVenueNames(["SIGMOD"]), "A");
  });

  it("should detect CCF-B from full conference names", function () {
    assert.equal(
      detectCCFLevelByVenueNames([
        "ACM International Conference on Information and Knowledge Management",
      ]),
      "B",
    );
  });

  it("should detect CCF-C from conference aliases", function () {
    assert.equal(detectCCFLevelByVenueNames(["PAKDD"]), "C");
  });

  it("should return null for unknown venues", function () {
    assert.isNull(detectCCFLevelByVenueNames(["Unknown Venue XYZ"]));
  });
});
