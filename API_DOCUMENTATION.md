# SpireONE Backend API Documentation — User Cars & AI Magazine (D1 Storage)

This documentation specifies the endpoints for managing user cars and daily AI-summarized car magazine news stored in Cloudflare D1.

## Base URL
`https://spireonebackend.carspirethailand.workers.dev` (Production)
`http://localhost:8787` (Local Dev)

## Authentication
Certain endpoints require a Google Firebase ID token (JWT) passed in the `Authorization` header as a Bearer token.
* **Header Format**: `Authorization: Bearer <FIREBASE_ID_TOKEN>`

---

## Cars Endpoints

### 1. Retrieve User Cars
Get all cars associated with the authenticated user's profile.

* **URL**: `/api/cars`
* **Method**: `GET`
* **Headers**:
  * `Authorization: Bearer <ID_TOKEN>`
* **Response (Success `200 OK`)**:
  Returns a JSON array of car objects sorted by `created_at DESC`.
  ```json
  [
    {
      "id": "c17373822292",
      "uid": "user_firebase_uid_12345",
      "make": "Toyota",
      "model": "Fortuner",
      "year": "2020",
      "mileage": "150000",
      "created_at": 1719593123456
    }
  ]
  ```
* **Response (Error)**:
  * `401 Unauthorized`: JWT is expired, missing, or signature verification failed.
    ```json
    { "error": "Invalid authentication token: jwt expired" }
    ```
  * `500 Internal Server Error`: D1 connection failure.

---

### 2. Add or Update User Car (Upsert)
Saves a new car or updates an existing car's specifications (Make, Model, Year, Mileage).
* **URL**: `/api/cars`
* **Method**: `POST`
* **Headers**:
  * `Authorization: Bearer <ID_TOKEN>`
  * `Content-Type: application/json`
* **Request Body**:
  ```json
  {
    "id": "c17373822292",     // Optional. If omitted, the server generates a new ID.
    "make": "Toyota",          // Required.
    "model": "Fortuner",       // Required.
    "year": "2020",            // Optional. Defaults to "".
    "mileage": "150000"        // Optional. Defaults to "".
  }
  ```
* **Response (Success `200 OK`)**:
  ```json
  {
    "id": "c17373822292",
    "uid": "user_firebase_uid_12345",
    "make": "Toyota",
    "model": "Fortuner",
    "year": "2020",
    "mileage": "150000",
    "created_at": 1719593123456
  }
  ```
* **Response (Error)**:
  * `400 Bad Request`: Missing `make` or `model` fields, or invalid JSON request body.
    ```json
    { "error": "Missing required fields: make, model" }
    ```
  * `401 Unauthorized`: Token verification failed.
  * `500 Internal Server Error`: Database constraint violations.

---

### 3. Remove User Car
Deletes a car record. The API verifies that the car belongs to the authenticated user before executing the deletion.
* **URL**: `/api/cars/:id` (e.g. `/api/cars/c17373822292`)
* **Method**: `DELETE`
* **Headers**:
  * `Authorization: Bearer <ID_TOKEN>`
* **Response (Success `200 OK`)**:
  ```json
  {
    "success": true,
    "message": "Car removed successfully"
  }
  ```
* **Response (Error)**:
  * `400 Bad Request`: Car ID segment is missing in the URL path.
  * `401 Unauthorized`: Token verification failed.
  * `404 Not Found`: Car record does not exist or does not belong to the requesting user.
    ```json
    { "error": "Car not found or unauthorized" }
    ```
  * `500 Internal Server Error`: D1 connection failure.

---

## Magazine Endpoints

### 1. Retrieve Daily Summarized News
Get the cached daily car news summaries retrieved from Gemini today.
* **URL**: `/api/magazine`
* **Method**: `GET`
* **Authentication**: None (Public)
* **Response (Success `200 OK`)**:
  Returns a JSON array of news objects.
  ```json
  [
    {
      "id": 1,
      "title": "เทรนด์รถยนต์ไฟฟ้า EV ประจำปี 2026",
      "short_description": "ความก้าวหน้าล่าสุดในแบตเตอรี่รถไฟฟ้าและการสร้างสถานีชาร์จในไทย",
      "full_description": "เนื้อข่าวโดยละเอียดที่ไม่เกิน 6 บรรทัดสรุปสาระสำคัญ ทั้งการประเมินราคา ความจุแบตเตอรี่แบบ Solid-state ที่แบรนด์ชั้นนำเริ่มผลิต และการขยายเครือข่ายหัวจ่ายไฟความเร็วสูงบนถนนสายหลัก",
      "type": "เทคโนโลยี",
      "created_at": 1719593123456
    }
  ]
  ```
* **Response (Error)**:
  * `500 Internal Server Error`: D1 database connection failure.

---

### 2. Force Refresh Daily News (Manual Sync)
Allows administrators to manually invoke the Gemini AI summarization process and update the D1 cached database immediately. Useful for testing and manual sync triggers.
* **URL**: `/api/magazine/sync`
* **Method**: `POST`
* **Headers**:
  * `Authorization: Bearer <ADMIN_ID_TOKEN>`
* **Response (Success `200 OK`)**:
  ```json
  {
    "success": true,
    "message": "Magazine news synchronized successfully"
  }
  ```
* **Response (Error)**:
  * `401 Unauthorized`: Token is missing or invalid.
  * `403 Forbidden`: User is authenticated but is not listed in the administrators list.
  * `500 Internal Server Error`: Gemini API call failed or D1 connection write failed.
