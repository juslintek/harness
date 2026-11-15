import XCTest

final class HarnessEndToEndUITests: XCTestCase {
    private var localServer: LocalHarnessTestServer?

    override func tearDownWithError() throws {
        localServer?.stop()
        localServer = nil
        XCUIDevice.shared.appearance = .light
        try super.tearDownWithError()
    }

    @MainActor
    func testFullMobileEndToEndFlow() throws {
        let env = ProcessInfo.processInfo.environment
        let origin: String
        let pairCode: String
        let isLiveServer: Bool

        if let configuredOrigin = env["HARNESS_TEST_ORIGIN"], !configuredOrigin.isEmpty {
            origin = configuredOrigin
            let pCode = env["HARNESS_TEST_PAIR_CODE"] ?? ""
            pairCode = !pCode.isEmpty ? pCode : (env["HARNESS_TEST_ENROLL_CODE"] ?? "123456")
            isLiveServer = true
        } else {
            let server = try LocalHarnessTestServer()
            try server.start()
            self.localServer = server
            origin = server.origin
            pairCode = "123456"
            isLiveServer = false
        }

        XCUIDevice.shared.appearance = .light

        let app = XCUIApplication()
        app.launchEnvironment["HARNESS_TEST_SIGNER"] = "1"
        app.launchEnvironment["HARNESS_RESET_STATE"] = "1"
        app.launchEnvironment["HARNESS_TEST_ORIGIN"] = origin
        app.launchEnvironment["HARNESS_TEST_ENROLL_CODE"] = pairCode
        app.launch()

        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 5.0))

        // 1. Pair / Enroll with real P-256 key
        let instancePicker = app.buttons["header.instancePicker"].firstMatch
        XCTAssertTrue(instancePicker.waitForExistence(timeout: 5.0))
        instancePicker.tap()

        let pairMenuItem = app.buttons["Pair New Instance..."].firstMatch
        XCTAssertTrue(pairMenuItem.waitForExistence(timeout: 3.0))
        pairMenuItem.tap()

        let originField = app.textFields["pair.origin"].firstMatch
        XCTAssertTrue(originField.waitForExistence(timeout: 3.0))
        if (originField.value as? String) != origin {
            replaceText(in: originField, with: origin)
        }

        let codeField = app.textFields["pair.code"].firstMatch
        XCTAssertTrue(codeField.waitForExistence(timeout: 3.0))
        if (codeField.value as? String) != pairCode {
            replaceText(in: codeField, with: pairCode)
        }

        let submitButton = app.buttons["pair.submit"].firstMatch
        XCTAssertTrue(submitButton.waitForExistence(timeout: 3.0))
        submitButton.tap()

        // Wait for pairing sheet to dismiss
        let haltExists = app.buttons["button.halt"].waitForExistence(timeout: 8.0)
        let pairErr = app.staticTexts["pair.error"].exists ? app.staticTexts["pair.error"].label : "none"
        XCTAssertTrue(haltExists, "Expected button.halt after pairing (pair.error=\(pairErr))")

        // 2. Approvals tab: countdown + step-up Approve
        let approveButton = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'approval.approve.'")).firstMatch
        XCTAssertTrue(approveButton.waitForExistence(timeout: 8.0), "Expected approval card button")
        let countdownPredicate = NSPredicate(format: "label CONTAINS 'remaining'")
        let countdownText = app.staticTexts.containing(countdownPredicate).firstMatch
        XCTAssertTrue(countdownText.waitForExistence(timeout: 5.0), "Expected approval countdown text")

        approveButton.tap()
        let approvedBanner = app.staticTexts.containing(NSPredicate(format: "label CONTAINS[c] 'approved'")).firstMatch
        XCTAssertTrue(approvedBanner.waitForExistence(timeout: 5.0) || !approveButton.exists)

        captureScreenshot(name: "e2e-light-approvals", env: env)

        // 3. Board tab: columns + task detail
        tapTab(named: "Board", identifier: "tab.board", in: app)
        XCTAssertTrue(app.buttons["board.newTask"].waitForExistence(timeout: 5.0))

        let todoPill = app.buttons.containing(NSPredicate(format: "label CONTAINS 'To Do'")).firstMatch
        if todoPill.waitForExistence(timeout: 3.0) {
            todoPill.tap()
        }
        let expectedTaskTitle = isLiveServer ? "Verify offline approval banner" : "Verify E2E pipeline"
        let taskTitleNode = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", expectedTaskTitle)).firstMatch
        XCTAssertTrue(taskTitleNode.waitForExistence(timeout: 8.0), "Expected seeded board task card")
        taskTitleNode.tap()
        XCTAssertTrue(app.staticTexts[expectedTaskTitle].firstMatch.waitForExistence(timeout: 5.0))
        let doneButton = app.buttons["Done"].firstMatch
        XCTAssertTrue(doneButton.waitForExistence(timeout: 3.0))
        doneButton.tap()

        // 4. Runs tab: transcript view
        tapTab(named: "Runs", identifier: "tab.runs", in: app)
        let runCard = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'runs.card.'")).firstMatch
        XCTAssertTrue(runCard.waitForExistence(timeout: 8.0), "Expected seeded run card")
        runCard.tap()
        let expectedTranscript = isLiveServer ? "relay.test.ts" : "Running E2E transcript verification"
        let transcriptLine = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", expectedTranscript)).firstMatch
        XCTAssertTrue(transcriptLine.waitForExistence(timeout: 5.0), "Expected run transcript line")
        let backButton = app.navigationBars.buttons.element(boundBy: 0)
        if backButton.exists {
            backButton.tap()
        }

        // 5. Chat tab: channel message send
        tapTab(named: "Chat", identifier: "tab.chat", in: app)
        let channelButton = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'chat.channel.'")).firstMatch
        XCTAssertTrue(channelButton.waitForExistence(timeout: 8.0), "Expected seeded chat channel")
        channelButton.tap()
        let composer = app.textViews["chat.composer"].firstMatch.exists
            ? app.textViews["chat.composer"].firstMatch
            : app.textFields["chat.composer"].firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 5.0))
        composer.tap()
        composer.typeText("Hello from XCUITest")

        let sendButton = app.buttons["chat.send"].firstMatch
        XCTAssertTrue(sendButton.waitForExistence(timeout: 3.0))
        sendButton.tap()

        let sentMessage = app.staticTexts["Hello from XCUITest"].firstMatch
        XCTAssertTrue(sentMessage.waitForExistence(timeout: 5.0))

        let chatBackButton = app.navigationBars.buttons.element(boundBy: 0)
        if chatBackButton.exists {
            chatBackButton.tap()
        }

        // 6. Workspace tab: Dashboard & Memory Vault
        tapTab(named: "Workspace", identifier: "tab.workspace", in: app)
        XCTAssertTrue(app.navigationBars["Workspace"].waitForExistence(timeout: 5.0))

        let memorySegment = app.buttons["Memory Vault"].firstMatch
        XCTAssertTrue(memorySegment.waitForExistence(timeout: 5.0))
        memorySegment.tap()
        let expectedNote = isLiveServer ? "mobile-architecture.md" : "E2E Note"
        let memoryNote = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", expectedNote)).firstMatch
        XCTAssertTrue(memoryNote.waitForExistence(timeout: 6.0), "Expected seeded memory note")

        // 7. Dark mode screenshot
        XCUIDevice.shared.appearance = .dark
        RunLoop.current.run(until: Date().addingTimeInterval(0.6))
        captureScreenshot(name: "e2e-dark-workspace", env: env)
    }

    private func tapTab(named title: String, identifier: String, in app: XCUIApplication) {
        let tabBar = app.tabBars.firstMatch
        let byId = tabBar.buttons[identifier]
        if byId.exists {
            byId.tap()
        } else {
            let byTitle = tabBar.buttons[title]
            XCTAssertTrue(byTitle.waitForExistence(timeout: 4.0))
            byTitle.tap()
        }
    }

    private func replaceText(in element: XCUIElement, with text: String) {
        let placeholder = element.placeholderValue ?? ""
        let initialValue = element.value as? String ?? ""
        if initialValue.isEmpty || initialValue == placeholder {
            element.tap()
        } else {
            element.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
            let deleteString = String(repeating: XCUIKeyboardKey.delete.rawValue, count: initialValue.count)
            element.typeText(deleteString)
        }
        element.typeText(text)
    }

    private func captureScreenshot(name: String, env: [String: String]) {
        let screenshot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)

        if let dir = env["HARNESS_SCREENSHOT_DIR"], !dir.isEmpty {
            let dirURL = URL(fileURLWithPath: dir, isDirectory: true)
            try? FileManager.default.createDirectory(at: dirURL, withIntermediateDirectories: true)
            let fileURL = dirURL.appendingPathComponent("\(name).png")
            try? screenshot.pngRepresentation.write(to: fileURL)
        }
    }
}
