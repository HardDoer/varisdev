pipeline {
    agent any
    options {
        skipDefaultCheckout(true)
        disableConcurrentBuilds()
    }
    environment {
        RELEASE_IMAGE = "jnokikana/joonas.ninja:varisdev-${BUILD_NUMBER}"
        LATEST_RELEASE_IMAGE = 'jnokikana/joonas.ninja:varisdev-latest'
    }
    stages {
        stage('Checkout') {
            steps {
                checkout scm
            }
        }
        stage('Build') {
            steps {
                sh 'docker build -t "$RELEASE_IMAGE" .'
            }
        }
        stage('Login') {
            steps {
                withCredentials([usernamePassword(usernameVariable: 'USERNAME', passwordVariable: 'PASSWORD', credentialsId: '06401b2c-c73a-4fb8-9a44-95cdc301d3d3')]) {
                    sh 'printf "%s" "$PASSWORD" | docker login --username "$USERNAME" --password-stdin'
                }
            }
        }
        stage('Push to artifactory') {
            steps {
                sh 'docker push "$RELEASE_IMAGE"'
                sh 'docker tag "$RELEASE_IMAGE" "$LATEST_RELEASE_IMAGE"'
                sh 'docker push "$LATEST_RELEASE_IMAGE"'
                echo "Release image: ${env.RELEASE_IMAGE} (also available as ${env.LATEST_RELEASE_IMAGE})"
            }
        }
    }
}
