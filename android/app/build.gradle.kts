import java.util.Properties

plugins {
  alias(libs.plugins.android.application)
  alias(libs.plugins.kotlin.android)
  alias(libs.plugins.kotlin.compose)
}

android {
  namespace = "com.pimobile.app"
  compileSdk = 35

  defaultConfig {
    applicationId = "com.pimobile.app"
    minSdk = 26
    targetSdk = 35
    versionCode = 1
    versionName = "1.0"

    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
  }

  signingConfigs {
    create("release") {
      // Only enforce keystore/password during Release builds. Debug builds use
      // Android's default debug keystore (buildTypes.debug has no signingConfig),
      // so we skip the password check + file lookup to keep `assembleDebug`
      // runnable on machines without the release keystore configured.
      // (Fixes P2-6 regression: the unconditional throw blocked ALL builds.)
      val isReleaseBuild = gradle.startParameter.taskNames.any { it.contains("Release") }
      if (isReleaseBuild) {
        val localProperties = Properties().apply {
          val localFile = rootProject.file("local.properties")
          if (localFile.exists()) localFile.inputStream().use { load(it) }
        }

        val keystorePath = System.getenv("KEYSTORE_PATH")
          ?: localProperties.getProperty("KEYSTORE_PATH")
          ?: "${rootDir}/my-upload-key.jks"

        storeFile = file(keystorePath)

        val storePass = System.getenv("STORE_PASSWORD")
          ?: localProperties.getProperty("STORE_PASSWORD")

        val keyPass = System.getenv("KEY_PASSWORD")
          ?: localProperties.getProperty("KEY_PASSWORD")
          ?: storePass

        if (storePass.isNullOrEmpty()) {
          throw GradleException(
            """
            |========================================
            | Release signing password is not configured!
            |
            | Set one of the following:
            |   Option 1: Environment variables
            |     export STORE_PASSWORD="your_password"
            |     export KEY_PASSWORD="your_password"
            |
            |   Option 2: local.properties (gitignored)
            |     STORE_PASSWORD=your_password
            |     KEY_PASSWORD=your_password
            |========================================
            """.trimMargin()
          )
        }

        storePassword = storePass
        keyAlias = "upload"
        keyPassword = keyPass
      } else {
        // Placeholders so SigningConfig evaluates during debug builds without
        // requiring a keystore. buildTypes.debug never references this config.
        storeFile = file("${rootDir}/my-upload-key.jks")
        storePassword = ""
        keyAlias = "upload"
        keyPassword = ""
      }
    }
  }

  buildTypes {
    release {
      isCrunchPngs = false
      isMinifyEnabled = false
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
      signingConfig = signingConfigs.getByName("release")
    }
    debug {
      // Uses default Android debug keystore
    }
  }
  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_11
    targetCompatibility = JavaVersion.VERSION_11
  }
  kotlinOptions {
    jvmTarget = "11"
  }
  buildFeatures {
    compose = true
    buildConfig = true
  }
  testOptions { unitTests { isIncludeAndroidResources = true } }
}

// Some unused dependencies are commented out below instead of being removed.
// This makes it easy to add them back in the future if needed.
dependencies {
  implementation(platform(libs.androidx.compose.bom))
  implementation(libs.androidx.activity.compose)
  implementation(libs.androidx.compose.material.icons.core)
  implementation(libs.androidx.compose.material.icons.extended)
  implementation(libs.androidx.compose.material3)
  implementation(libs.androidx.compose.ui)
  implementation(libs.androidx.compose.ui.graphics)
  implementation(libs.androidx.compose.ui.tooling.preview)
  implementation(libs.androidx.core.ktx)
  implementation(libs.androidx.lifecycle.runtime.compose)
  implementation(libs.androidx.lifecycle.runtime.ktx)
  implementation(libs.androidx.lifecycle.viewmodel.compose)
  implementation(libs.androidx.navigation.compose)
  implementation(libs.kotlinx.coroutines.android)
  implementation(libs.kotlinx.coroutines.core)

  // Network & Data (Phase 3)
  implementation(libs.okhttp)
  implementation(libs.androidx.datastore.preferences)
  testImplementation(libs.androidx.compose.ui.test.junit4)
  testImplementation(libs.androidx.core)
  testImplementation(libs.androidx.junit)
  testImplementation(libs.junit)
  testImplementation(libs.kotlinx.coroutines.test)
  testImplementation(libs.robolectric)
  androidTestImplementation(platform(libs.androidx.compose.bom))
  androidTestImplementation(libs.androidx.compose.ui.test.junit4)
  androidTestImplementation(libs.androidx.espresso.core)
  androidTestImplementation(libs.androidx.junit)
  androidTestImplementation(libs.androidx.runner)
  debugImplementation(libs.androidx.compose.ui.test.manifest)
  debugImplementation(libs.androidx.compose.ui.tooling)
}
