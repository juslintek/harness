import SwiftUI
import UIKit

public enum StudioNorthTheme {
    public enum Radii {
        public static let sm: CGFloat = 12
        public static let md: CGFloat = 24
        public static let pill: CGFloat = 999
    }

    public static let hairline: CGFloat = 1.0

    public static let surface = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(hex: "#181C17")
            : UIColor(hex: "#F3F0E8")
    })

    public static let surfaceRaised = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(hex: "#232921")
            : UIColor(hex: "#D0D6BC")
    })

    public static let ink = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(hex: "#F3F0E8")
            : UIColor(hex: "#252A24")
    })

    public static let inkMuted = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(hex: "#A9B29C")
            : UIColor(hex: "#626C57")
    })

    public static let border = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(hex: "#343C31")
            : UIColor(hex: "#CACCC0")
    })

    public static let brand = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(hex: "#F3F0E8")
            : UIColor(hex: "#252A24")
    })

    public static let onBrand = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(hex: "#181C17")
            : UIColor(hex: "#F3F0E8")
    })

    public static let accent = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(hex: "#EDBD85")
            : UIColor(hex: "#EDBD85")
    })

    public static let link = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(hex: "#A3B586")
            : UIColor(hex: "#77845D")
    })

    public static let danger = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(hex: "#E07A5F")
            : UIColor(hex: "#A4452C")
    })
}

extension UIColor {
    public convenience init(hex: String) {
        var cleanHex = hex.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        if cleanHex.hasPrefix("#") {
            cleanHex.removeFirst()
        }
        var rgbValue: UInt64 = 0
        Scanner(string: cleanHex).scanHexInt64(&rgbValue)

        let r = CGFloat((rgbValue & 0xFF0000) >> 16) / 255.0
        let g = CGFloat((rgbValue & 0x00FF00) >> 8) / 255.0
        let b = CGFloat(rgbValue & 0x0000FF) / 255.0

        self.init(red: r, green: g, blue: b, alpha: 1.0)
    }
}
