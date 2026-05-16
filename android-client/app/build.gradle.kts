import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val productionBaseUrl = "https://pedivoy.com/pedidos/app/"
val debugBaseUrl = (project.findProperty("pedivoyDebugBaseUrl") as String?)
    ?.takeIf { it.isNotBlank() }
    ?: productionBaseUrl

val keyPropertiesFile = rootProject.file("key.properties")
val keyProperties = Properties()
val hasReleaseSigning = keyPropertiesFile.exists().also { exists ->
    if (exists) keyPropertiesFile.inputStream().use(keyProperties::load)
}

android {
    namespace = "com.pedivoy.clientes"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.pedivoy.clientes"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = rootProject.file(keyProperties["storeFile"] as String)
                storePassword = keyProperties["storePassword"] as String
                keyAlias = keyProperties["keyAlias"] as String
                keyPassword = keyProperties["keyPassword"] as String
            }
        }
    }

    buildTypes {
        debug {
            versionNameSuffix = "-debug"
            manifestPlaceholders["usesCleartextTraffic"] = debugBaseUrl.startsWith("http://")
            resValue("string", "base_url", debugBaseUrl)
        }
        release {
            isMinifyEnabled = false
            manifestPlaceholders["usesCleartextTraffic"] = false
            resValue("string", "base_url", productionBaseUrl)
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("release")
            }
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        viewBinding = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.core:core-splashscreen:1.0.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    implementation("androidx.swiperefreshlayout:swiperefreshlayout:1.1.0")
}
