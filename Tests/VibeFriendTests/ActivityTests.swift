import XCTest
@testable import VibeFriend

final class ActivityTests: XCTestCase {
    func testEntryStartsWithProvidedSeconds() {
        let entry = ActivityEntry(app: "Safari", seconds: 10)
        XCTAssertEqual(entry.app, "Safari")
        XCTAssertEqual(entry.seconds, 10)
    }
    func testEntryCodableRoundTrip() throws {
        let entry = ActivityEntry(app: "Xcode", seconds: 42)
        let decoded = try JSONDecoder().decode(ActivityEntry.self, from: JSONEncoder().encode(entry))
        XCTAssertEqual(decoded.app, entry.app)
        XCTAssertEqual(decoded.seconds, entry.seconds)
    }
}
